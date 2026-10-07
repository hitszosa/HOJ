// @generated automatically by Diesel CLI.

diesel::table! {
    announcements (id) {
        content -> Text,
        created_at -> Datetime,
        created_by -> Bigint,
        #[max_length = 100]
        display -> Varchar,
        effective_until -> Datetime,
        enable -> Bool,
        id -> Bigint,
        publish_date -> Datetime,
        #[max_length = 255]
        title -> Varchar,
        updated_at -> Datetime,
    }
}

diesel::table! {
    assignments (id) {
        #[max_length = 100]
        allowed_extension -> Nullable<Varchar>,
        course_id -> Bigint,
        created_at -> Datetime,
        creator_id -> Nullable<Bigint>,
        description -> Nullable<Text>,
        due_time -> Datetime,
        id -> Bigint,
        max_file_size -> Integer,
        published -> Bool,
        score -> Integer,
        show_score -> Bool,
        start_time -> Datetime,
        #[max_length = 60]
        title -> Varchar,
        updated_at -> Datetime,
    }
}

diesel::table! {
    audit_logs (id) {
        #[max_length = 50]
        action -> Varchar,
        affected_user_id -> Nullable<Bigint>,
        assignment_id -> Nullable<Bigint>,
        course_id -> Nullable<Bigint>,
        created_at -> Datetime,
        description -> Text,
        id -> Bigint,
        #[max_length = 45]
        ip_address -> Nullable<Varchar>,
        new_values -> Nullable<Longtext>,
        old_values -> Nullable<Longtext>,
        resource_id -> Nullable<Bigint>,
        #[max_length = 50]
        resource_type -> Varchar,
        #[max_length = 255]
        session_id -> Nullable<Varchar>,
        #[max_length = 150]
        username -> Varchar,
        user_agent -> Nullable<Text>,
        user_id -> Bigint,
        user_role -> Integer,
    }
}

diesel::table! {
    cache_revision (id) {
        #[max_length = 36]
        auth_revision -> Varchar,
        id -> Integer,
        #[max_length = 36]
        revision -> Varchar,
    }
}

diesel::table! {
    code_grading_documents (submission_id, original_sha256) {
        #[max_length = 64]
        original_sha256 -> Varchar,
        page_count -> Integer,
        #[max_length = 64]
        pdf_sha256 -> Varchar,
        #[max_length = 255]
        preview_file_ident -> Varchar,
        #[max_length = 64]
        source_version -> Varchar,
        submission_id -> Bigint,
    }
}

diesel::table! {
    code_grading_reviews (submission_id) {
        base_cents -> Integer,
        files -> Mediumtext,
        marks -> Mediumtext,
        revision -> Bigint,
        #[max_length = 255]
        source_file_ident -> Varchar,
        #[max_length = 64]
        source_sha256 -> Varchar,
        submission_id -> Bigint,
        updated_at -> Datetime,
        updated_by -> Nullable<Bigint>,
    }
}

diesel::table! {
    course_assistants (id) {
        course_id -> Bigint,
        created_at -> Datetime,
        id -> Bigint,
        user_id -> Bigint,
    }
}

diesel::table! {
    course_students (id) {
        course_id -> Bigint,
        created_at -> Datetime,
        id -> Bigint,
        user_id -> Bigint,
    }
}

diesel::table! {
    course_teachers (id) {
        course_id -> Bigint,
        created_at -> Datetime,
        id -> Bigint,
        user_id -> Bigint,
    }
}

diesel::table! {
    courses (id) {
        created_at -> Datetime,
        id -> Bigint,
        term -> Integer,
        #[max_length = 60]
        title -> Varchar,
        updated_at -> Datetime,
        year -> Integer,
    }
}

diesel::table! {
    file_info (id) {
        assignment_id -> Nullable<Bigint>,
        #[max_length = 255]
        content_type -> Nullable<Varchar>,
        created_at -> Datetime,
        #[max_length = 255]
        file_ident -> Varchar,
        #[max_length = 500]
        file_name -> Nullable<Varchar>,
        file_size -> Nullable<Bigint>,
        id -> Bigint,
        uploaded_by -> Nullable<Bigint>,
        upload_expires_at -> Nullable<Datetime>,
        upload_finished_at -> Nullable<Datetime>,
        #[max_length = 32]
        upload_purpose -> Varchar,
        #[max_length = 20]
        upload_state -> Varchar,
    }
}

diesel::table! {
    grading_documents (submission_id) {
        page_count -> Integer,
        #[max_length = 255]
        preview_file_ident -> Nullable<Varchar>,
        #[max_length = 255]
        source_file_ident -> Varchar,
        submission_id -> Bigint,
        #[max_length = 36]
        version -> Varchar,
    }
}

diesel::table! {
    grading_reviews (submission_id) {
        base_cents -> Integer,
        marks -> Mediumtext,
        revision -> Bigint,
        submission_id -> Bigint,
        updated_at -> Datetime,
        updated_by -> Nullable<Bigint>,
    }
}

diesel::table! {
    grading_rubrics (assignment_id, user_id) {
        assignment_id -> Bigint,
        base_cents -> Integer,
        revision -> Bigint,
        rules -> Mediumtext,
        user_id -> Bigint,
    }
}

diesel::table! {
    mobile_sso_tickets (session_id) {
        expires_at -> Datetime,
        session_id -> Bigint,
        #[max_length = 64]
        ticket_hash -> Char,
    }
}

diesel::table! {
    oauth_access_token_course_grants (id) {
        access_token_id -> Bigint,
        course_id -> Bigint,
        created_at -> Datetime,
        id -> Bigint,
    }
}

diesel::table! {
    oauth_access_tokens (id) {
        created_at -> Datetime,
        expires_at -> Datetime,
        id -> Bigint,
        last_used_at -> Nullable<Datetime>,
        oauth_client_id -> Bigint,
        revoked_at -> Nullable<Datetime>,
        scopes -> Text,
        #[max_length = 64]
        token_hash -> Char,
        user_id -> Bigint,
    }
}

diesel::table! {
    oauth_authorization_codes (id) {
        #[max_length = 255]
        code_challenge -> Nullable<Varchar>,
        #[max_length = 16]
        code_challenge_method -> Nullable<Varchar>,
        #[max_length = 64]
        code_hash -> Char,
        created_at -> Datetime,
        expires_at -> Datetime,
        id -> Bigint,
        oauth_client_id -> Bigint,
        #[max_length = 2048]
        redirect_uri -> Varchar,
        scopes -> Text,
        used_at -> Nullable<Datetime>,
        user_id -> Bigint,
    }
}

diesel::table! {
    oauth_clients (id) {
        active -> Bool,
        allowed_scopes -> Text,
        #[max_length = 128]
        client_id -> Varchar,
        #[max_length = 64]
        client_secret_hash -> Nullable<Char>,
        created_at -> Datetime,
        created_by -> Nullable<Bigint>,
        id -> Bigint,
        #[max_length = 255]
        name -> Varchar,
        #[max_length = 2048]
        redirect_uri -> Varchar,
        updated_at -> Datetime,
    }
}

diesel::table! {
    oauth_consents (id) {
        granted_at -> Datetime,
        id -> Bigint,
        oauth_client_id -> Bigint,
        revoked_at -> Nullable<Datetime>,
        scopes -> Text,
        user_id -> Bigint,
    }
}

diesel::table! {
    submissions (id) {
        assignment_id -> Bigint,
        created_at -> Datetime,
        #[max_length = 255]
        file_ident -> Nullable<Varchar>,
        id -> Bigint,
        score -> Double,
        status -> Integer,
        submit_time -> Datetime,
        updated_at -> Datetime,
        user_id -> Bigint,
    }
}

diesel::table! {
    user_sessions (id) {
        created_at -> Nullable<Datetime>,
        expires_at -> Datetime,
        id -> Bigint,
        session_data -> Nullable<Text>,
        #[max_length = 32]
        session_key -> Varchar,
        user_id -> Bigint,
    }
}

diesel::table! {
    users (id) {
        created_at -> Datetime,
        date_joined -> Datetime,
        #[max_length = 254]
        email -> Nullable<Varchar>,
        #[max_length = 150]
        first_name -> Nullable<Varchar>,
        id -> Bigint,
        is_active -> Bool,
        is_staff -> Bool,
        last_login -> Nullable<Datetime>,
        #[max_length = 150]
        last_name -> Nullable<Varchar>,
        #[max_length = 255]
        password -> Varchar,
        password_expired -> Bool,
        #[max_length = 1000]
        real_name -> Varchar,
        role -> Integer,
        updated_at -> Datetime,
        #[max_length = 150]
        username -> Varchar,
    }
}

diesel::joinable!(announcements -> users (created_by));
diesel::joinable!(assignments -> courses (course_id));
diesel::joinable!(assignments -> users (creator_id));
diesel::joinable!(code_grading_documents -> submissions (submission_id));
diesel::joinable!(code_grading_reviews -> submissions (submission_id));
diesel::joinable!(code_grading_reviews -> users (updated_by));
diesel::joinable!(course_assistants -> courses (course_id));
diesel::joinable!(course_assistants -> users (user_id));
diesel::joinable!(course_students -> courses (course_id));
diesel::joinable!(course_students -> users (user_id));
diesel::joinable!(course_teachers -> courses (course_id));
diesel::joinable!(course_teachers -> users (user_id));
diesel::joinable!(file_info -> assignments (assignment_id));
diesel::joinable!(file_info -> users (uploaded_by));
diesel::joinable!(grading_documents -> submissions (submission_id));
diesel::joinable!(grading_reviews -> grading_documents (submission_id));
diesel::joinable!(grading_reviews -> users (updated_by));
diesel::joinable!(grading_rubrics -> assignments (assignment_id));
diesel::joinable!(grading_rubrics -> users (user_id));
diesel::joinable!(mobile_sso_tickets -> user_sessions (session_id));
diesel::joinable!(oauth_access_token_course_grants -> courses (course_id));
diesel::joinable!(oauth_access_token_course_grants -> oauth_access_tokens (access_token_id));
diesel::joinable!(oauth_access_tokens -> oauth_clients (oauth_client_id));
diesel::joinable!(oauth_access_tokens -> users (user_id));
diesel::joinable!(oauth_authorization_codes -> oauth_clients (oauth_client_id));
diesel::joinable!(oauth_authorization_codes -> users (user_id));
diesel::joinable!(oauth_clients -> users (created_by));
diesel::joinable!(oauth_consents -> oauth_clients (oauth_client_id));
diesel::joinable!(oauth_consents -> users (user_id));
diesel::joinable!(submissions -> assignments (assignment_id));
diesel::joinable!(submissions -> users (user_id));
diesel::joinable!(user_sessions -> users (user_id));

diesel::allow_tables_to_appear_in_same_query!(
    announcements,
    assignments,
    audit_logs,
    cache_revision,
    code_grading_documents,
    code_grading_reviews,
    course_assistants,
    course_students,
    course_teachers,
    courses,
    file_info,
    grading_documents,
    grading_reviews,
    grading_rubrics,
    mobile_sso_tickets,
    oauth_access_token_course_grants,
    oauth_access_tokens,
    oauth_authorization_codes,
    oauth_clients,
    oauth_consents,
    submissions,
    user_sessions,
    users,
);

// Local integration tables; the upstream academic schema remains intact.
diesel::table! { hoj_users (user_id) { user_id -> Bigint, } }
diesel::table! { hoj_offerings (offering_id) { offering_id -> Integer, course_id -> Bigint, } }
