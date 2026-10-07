use super::*;

#[derive(Deserialize)]
struct BatchLookupRequest {
    usernames: Vec<String>,
    ids: Vec<i64>,
}

#[derive(Serialize)]
struct LookupSuccess {
    user: UserInfo,
    idx: usize,
}

#[derive(Serialize)]
struct LookupFail {
    message: String,
    idx: usize,
}

#[derive(Serialize)]
struct BatchLookupResponse {
    success: Vec<LookupSuccess>,
    fail: Vec<LookupFail>,
}

async fn batch_lookup(
    Teacher(_current): Teacher,
    database: Database,
    Json(request): Json<BatchLookupRequest>,
) -> Result<Json<BatchLookupResponse>> {
    if request.usernames.is_empty() && request.ids.is_empty() {
        return Err(AppError::BadRequest(
            "Both usernames and ids lists are empty".into(),
        ));
    }
    if !request.usernames.is_empty() && !request.ids.is_empty() {
        return Err(AppError::BadRequest(
            "Only one of usernames or ids should be non-empty".into(),
        ));
    }

    let mut conn = database.connect().await?;
    let mut found = Vec::<UserInfo>::new();
    for chunk in request.usernames.chunks(1000) {
        found.extend(
            users::table
                .filter(users::is_active.eq(true))
                .filter(users::username.eq_any(chunk))
                .select(UserInfo::as_select())
                .load::<UserInfo>(&mut *conn)
                .await?,
        );
    }
    for chunk in request.ids.chunks(1000) {
        found.extend(
            users::table
                .filter(users::is_active.eq(true))
                .filter(users::id.eq_any(chunk))
                .select(UserInfo::as_select())
                .load::<UserInfo>(&mut *conn)
                .await?,
        );
    }
    let by_name = !request.usernames.is_empty();
    let found: HashMap<String, UserInfo> = found
        .into_iter()
        .map(|user| {
            (
                if by_name {
                    user.username.clone()
                } else {
                    user.id.to_string()
                },
                user,
            )
        })
        .collect();
    let keys = if by_name {
        request.usernames
    } else {
        request.ids.into_iter().map(|id| id.to_string()).collect()
    };
    let mut response = BatchLookupResponse {
        success: Vec::new(),
        fail: Vec::new(),
    };
    for (idx, key) in keys.into_iter().enumerate() {
        if let Some(user) = found.get(&key) {
            response.success.push(LookupSuccess {
                user: user.clone(),
                idx,
            });
        } else {
            response.fail.push(LookupFail {
                message: format!("user {key} not found"),
                idx,
            });
        }
    }
    Ok(Json(response))
}

#[derive(Deserialize)]
struct PrefixQuery {
    username_prefix: String,
}

async fn prefix_lookup(
    Teacher(_current): Teacher,
    Db(mut conn): Db,
    Query(query): Query<PrefixQuery>,
) -> Result<Json<Vec<UserInfo>>> {
    if query.username_prefix.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let result = users::table
        .filter(users::is_active.eq(true))
        .filter(users::username.like(format!("{}%", query.username_prefix)))
        .select(UserInfo::as_select())
        .order(users::username.asc())
        .limit(20)
        .load(&mut *conn)
        .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
struct FuzzyQuery {
    key: String,
    page_size: i32,
    page_num: i32,
    role: Option<i32>,
    include_count: Option<bool>,
}

#[derive(Serialize)]
struct FuzzyResponse {
    result: Vec<UserInfo>,
    has_more_pages: bool,
    length: Option<i64>,
}

async fn fuzzy_lookup(
    Teacher(_current): Teacher,
    Db(mut conn): Db,
    Query(query): Query<FuzzyQuery>,
) -> Result<Json<FuzzyResponse>> {
    if query.page_num < 1 {
        return Err(AppError::BadRequest(
            "Page number must be at least 1".into(),
        ));
    }
    if query.page_size < 0 {
        return Err(AppError::BadRequest(
            "Page size must be non-negative".into(),
        ));
    }
    let limit = if query.page_size == 0 {
        1000
    } else {
        i64::from(query.page_size.min(100))
    };
    let offset = if query.page_size == 0 {
        0
    } else {
        i64::from(query.page_num - 1) * limit
    };
    let pattern = format!("%{}%", query.key);
    let mut select = users::table
        .filter(users::is_active.eq(true))
        .select(UserInfo::as_select())
        .into_boxed();
    let mut count = users::table
        .filter(users::is_active.eq(true))
        .select(diesel::dsl::count_star())
        .into_boxed();
    if !query.key.is_empty() {
        select = select.filter(
            users::username
                .like(&pattern)
                .or(users::real_name.like(&pattern)),
        );
        count = count.filter(
            users::username
                .like(&pattern)
                .or(users::real_name.like(&pattern)),
        );
    }
    if let Some(role) = query.role {
        select = select.filter(users::role.eq(role));
        count = count.filter(users::role.eq(role));
    }

    let mut result: Vec<UserInfo> = select
        .order(users::id.asc())
        .limit(limit + 1)
        .offset(offset)
        .load(&mut *conn)
        .await?;
    let has_more_pages = result.len() > limit as usize;
    result.truncate(limit as usize);
    let length = if query.include_count.unwrap_or(true) {
        Some(count.first::<i64>(&mut *conn).await?)
    } else {
        None
    };
    Ok(Json(FuzzyResponse {
        result,
        has_more_pages,
        length,
    }))
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/users/user_batch_lookup", post(batch_lookup))
        .route("/users/user_prefix_lookup", route_get(prefix_lookup))
        .route("/users/user_fuzzy_lookup", route_get(fuzzy_lookup))
}
