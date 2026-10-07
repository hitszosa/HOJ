use crate::{
    app::{
        db::{self, Connection},
        error::{AppError, Result},
        state::AppState,
    },
    identity::auth::CurrentUser,
    schema::{course_assistants, course_students, course_teachers, users},
};
use axum::{
    extract::{FromRequestParts, Path},
    http::request::Parts,
};
use diesel::{dsl::exists, prelude::*};
use diesel_async::{AsyncMysqlConnection, RunQueryDsl};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Copy)]
pub enum Permission {
    Access,
    Assist,
    Manage,
    Administer,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
pub struct CoursePermissions {
    pub access: bool,
    pub assist: bool,
    pub manage: bool,
    pub administer: bool,
}

impl CoursePermissions {
    pub fn allows(self, permission: Permission) -> bool {
        match permission {
            Permission::Access => self.access,
            Permission::Assist => self.assist,
            Permission::Manage => self.manage,
            Permission::Administer => self.administer,
        }
    }

    pub fn require(self, permission: Permission) -> Result<()> {
        if self.allows(permission) {
            Ok(())
        } else {
            Err(AppError::Authorization("Course access denied".into()))
        }
    }
}

/// Read role and relationships together, rather than querying once per permission.
/// Mutations call this after locking the course, not from a cached request context.
pub async fn load(
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    course_id: i64,
) -> Result<CoursePermissions> {
    let teacher = exists(
        course_teachers::table
            .filter(course_teachers::course_id.eq(course_id))
            .filter(course_teachers::user_id.eq(user.id)),
    );
    let assistant = exists(
        course_assistants::table
            .filter(course_assistants::course_id.eq(course_id))
            .filter(course_assistants::user_id.eq(user.id)),
    );
    let student = exists(
        course_students::table
            .filter(course_students::course_id.eq(course_id))
            .filter(course_students::user_id.eq(user.id)),
    );

    let row = users::table
        .find(user.id)
        .filter(users::is_active.eq(true))
        .select((users::role, teacher, assistant, student))
        .first::<(i32, bool, bool, bool)>(conn)
        .await
        .optional()?;

    let Some((role, teacher, assistant, student)) = row else {
        return Ok(CoursePermissions::default());
    };
    let assist = role >= 2 || (role == 1 && teacher) || (role == 0 && assistant);

    Ok(CoursePermissions {
        access: role >= 1 || assist || (role == 0 && student),
        assist,
        // Teachers manage rosters only in their assigned courses. Course configuration
        // and teacher relationships are centrally maintained by administrators.
        manage: role >= 2 || (role == 1 && teacher),
        administer: role >= 2,
    })
}

/// Reuse only the authentication epoch that predates this request's resources.
/// Expired epochs and cache failures fall back on the already-borrowed connection.
pub async fn read(
    state: &AppState,
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    course_id: i64,
) -> Result<CoursePermissions> {
    let Some(epoch) = user
        .auth_epoch
        .as_ref()
        .filter(|epoch| chrono::Utc::now().timestamp_millis() < epoch.expires_at_ms)
    else {
        return load(conn, user, course_id).await;
    };
    let key = format!("permissions:{}:{}:{}", user.id, user.role, course_id);
    if let Some(permissions) = state.cache.auth_get::<CoursePermissions>(epoch, &key).await {
        return Ok(permissions);
    }
    let permissions = load(conn, user, course_id).await?;
    state
        .cache
        .auth_put(epoch, &key, &permissions, Duration::from_secs(300))
        .await;
    Ok(permissions)
}

pub async fn require(
    conn: &mut AsyncMysqlConnection,
    user: &CurrentUser,
    course_id: i64,
    permission: Permission,
) -> Result<()> {
    load(conn, user, course_id).await?.require(permission)
}

pub struct CourseContext {
    pub conn: Connection,
    pub id: i64,
}

async fn extract_course(
    parts: &mut Parts,
    state: &AppState,
    permission: Permission,
) -> Result<CourseContext, axum::response::Response> {
    use axum::response::IntoResponse;

    let user = CurrentUser::from_request_parts(parts, state)
        .await
        .map_err(IntoResponse::into_response)?;
    let Path(id) = Path::<i64>::from_request_parts(parts, state)
        .await
        .map_err(IntoResponse::into_response)?;
    let mut conn = db::connect(state)
        .await
        .map_err(IntoResponse::into_response)?;
    let permissions = read(state, &mut conn, &user, id)
        .await
        .map_err(IntoResponse::into_response)?;
    permissions
        .require(permission)
        .map_err(IntoResponse::into_response)?;

    Ok(CourseContext { conn, id })
}

/// Authorized course read; owns the same connection used by the handler.
pub struct CourseAccess(pub CourseContext);

impl FromRequestParts<AppState> for CourseAccess {
    type Rejection = axum::response::Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(
            extract_course(parts, state, Permission::Access).await?,
        ))
    }
}

/// Authorized course teaching/statistics read. Not a mutation-time permission cache.
pub struct CourseAssist(pub CourseContext);

impl FromRequestParts<AppState> for CourseAssist {
    type Rejection = axum::response::Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(
            extract_course(parts, state, Permission::Assist).await?,
        ))
    }
}
