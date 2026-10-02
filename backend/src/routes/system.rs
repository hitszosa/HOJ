//! 健康检查、开发体验账号、FAQ。

use std::collections::BTreeMap;

use axum::{Router, extract::State, routing::get};
use serde::Serialize;
use ts_rs::TS;

use crate::{
    auth::DEV_USERS,
    error::AppResult,
    response::{ApiOk, ok},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health)).route("/api/demo/users", get(demo_users)).route("/api/faq", get(faq))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Health {
    pub ok: bool,
    pub dev_login: bool,
    pub sso_configured: bool,
    pub sso_header: String,
    pub ai_configured: bool,
    pub login_url: &'static str,
    pub logout_url: &'static str,
    pub hustoj_url: &'static str,
}

async fn health(State(s): State<AppState>) -> ApiOk<Health> {
    ok(Health {
        ok: true,
        dev_login: s.cfg.dev_login,
        sso_configured: s.cfg.sso_configured,
        sso_header: s.cfg.sso_header.clone(),
        ai_configured: s.cfg.ai.url.is_some(),
        login_url: "/oj/loginpage.php",
        logout_url: "/oj/logout.php",
        hustoj_url: "/oj/course.php",
    })
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DemoTeacher {
    pub user_id: String,
    pub desc: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DemoStudent {
    pub user_id: String,
    pub student_no: String,
    pub desc: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct SsoSupport {
    pub enabled: bool,
    pub header: String,
    pub role_header: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DemoUsers {
    pub teachers: Vec<DemoTeacher>,
    pub students: Vec<DemoStudent>,
    /// 开发登录的角色 → 默认账号。
    pub default_users: BTreeMap<String, String>,
    pub sso_support: SsoSupport,
}

async fn demo_users(State(s): State<AppState>) -> AppResult<ApiOk<DemoUsers>> {
    let teaching = sqlx::query!(
        "SELECT DISTINCT o.teacher_id, c.code, c.name FROM cm_offering o JOIN cm_course c USING(course_id)
         WHERE o.status='active' ORDER BY c.code"
    )
    .fetch_all(&s.db)
    .await?;
    let mut teachers: Vec<(String, Vec<String>)> = Vec::new();
    for r in teaching {
        let label = format!("{} {}", r.code, r.name);
        match teachers.iter_mut().find(|(t, _)| *t == r.teacher_id) {
            Some((_, courses)) => courses.push(label),
            None => teachers.push((r.teacher_id, vec![label])),
        }
    }
    let mut teachers: Vec<DemoTeacher> =
        teachers.into_iter().map(|(user_id, c)| DemoTeacher { user_id, desc: format!("当前授课: {}", c.join(" / ")) }).collect();
    if !teachers.iter().any(|t| t.user_id == "admin") {
        teachers.push(DemoTeacher { user_id: "admin".into(), desc: "系统管理员（全校课程统览）".into() });
    }

    let enrolled = sqlx::query!(
        "SELECT DISTINCT e.user_id, e.student_no, c.code FROM cm_enrollment e
         JOIN cm_offering o USING(offering_id) JOIN cm_course c USING(course_id)
         WHERE e.status='active' AND e.role='student' ORDER BY e.user_id"
    )
    .fetch_all(&s.db)
    .await?;
    let mut students: Vec<(String, String, Vec<String>)> = Vec::new();
    for r in enrolled {
        match students.iter_mut().find(|(u, ..)| *u == r.user_id) {
            Some((.., courses)) => courses.push(r.code),
            None => {
                let no = r.student_no.filter(|n| !n.is_empty()).unwrap_or_else(|| r.user_id.clone());
                students.push((r.user_id, no, vec![r.code]));
            }
        }
    }
    let mut students: Vec<DemoStudent> = students
        .into_iter()
        .map(|(user_id, student_no, c)| DemoStudent { user_id, student_no, desc: format!("当前选修: {}", c.join(", ")) })
        .collect();
    if students.is_empty() {
        students.push(DemoStudent { user_id: "cm_pilot_student".into(), student_no: "2026001".into(), desc: "体验学生".into() });
    }
    Ok(ok(DemoUsers {
        teachers,
        students,
        default_users: DEV_USERS.iter().map(|(r, u)| ((*r).to_owned(), (*u).to_owned())).collect(),
        sso_support: SsoSupport {
            enabled: s.cfg.sso_configured,
            header: s.cfg.sso_header.clone(),
            role_header: s.cfg.sso_role_header.clone(),
        },
    }))
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Compiler {
    pub lang: &'static str,
    pub compiler: &'static str,
    pub command: &'static str,
    pub time_limit: &'static str,
    pub memory_limit: &'static str,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Verdict {
    pub code: &'static str,
    pub name: &'static str,
    pub color: &'static str,
    pub desc: &'static str,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct IoTip {
    pub title: &'static str,
    pub desc: &'static str,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Faq {
    pub compilers: Vec<Compiler>,
    pub verdicts: Vec<Verdict>,
    pub io_tips: Vec<IoTip>,
}

async fn faq() -> ApiOk<Faq> {
    let c = |lang, compiler, command, time_limit, memory_limit| Compiler { lang, compiler, command, time_limit, memory_limit };
    let v = |code, name, color, desc| Verdict { code, name, color, desc };
    ok(Faq {
        compilers: vec![
            c("C", "GCC 9.4+", "gcc -O2 -Wall -std=c11 source.c -lm", "1.0s", "128MB"),
            c("C++", "G++ 9.4+ / Clang", "g++ -O2 -Wall -std=c++17 source.cpp -lm", "1.0s", "128MB"),
            c("Python", "Python 3.9+", "python3 -u source.py", "3.0s (x3倍)", "256MB"),
            c("Java", "OpenJDK 17", "javac -J-Xms32m -J-Xmx256m Main.java / java Main", "2.0s (x2倍)", "256MB"),
        ],
        verdicts: vec![
            v("AC", "正确 (Accepted)", "ok", "恭喜！程序在全部测试点均输出了正确结果，且时空消耗在限制范围内。"),
            v("WA", "答案错误 (Wrong Answer)", "danger", "程序输出的内容与预期标准输出不符，请检查算法逻辑或边界用例。"),
            v("TLE", "时间超限 (Time Limit Exceeded)", "warn", "程序运行耗时超过限制，通常是因为算法复杂度过高或存在死循环。"),
            v("MLE", "内存超限 (Memory Limit Exceeded)", "warn", "程序申请的内存空间超出上限，请检查大型数组开辟或递归深度。"),
            v("RE", "运行错误 (Runtime Error)", "warn", "程序运行时崩溃，常见原因有除零、数组越界、空指针解引用或栈溢出。"),
            v("CE", "编译错误 (Compile Error)", "warn", "源码未通过编译器编译，点击该条记录可查看编译器详细报错提示。"),
            v("PE", "格式错误 (Presentation Error)", "neutral", "输出结果仅在空格或换行等格式排版上与标准输出存在细微差异。"),
            v("OLE", "输出超限 (Output Limit Exceeded)", "warn", "程序打印了过多冗余信息（如调试输出漏删或死循环打印）。"),
        ],
        io_tips: vec![
            IoTip {
                title: "关于多组测试数据读取 (EOF)",
                desc: "题目未声明输入组数时通常以文件末尾 EOF 为结束标志。C/C++ 可用 while(scanf(...) != EOF) 或 while(cin >> x)；Python 可用 sys.stdin.read().split() 批量处理。",
            },
            IoTip {
                title: "I/O 性能优化",
                desc: "在 C++ 中处理大数据量时，建议在 main 函数头部加入 std::ios::sync_with_stdio(false); std::cin.tie(nullptr); 并尽量避免使用 std::endl。",
            },
            IoTip {
                title: "避免冗余提示信息",
                desc: "提交代码中切勿包含“请输入：”等交互提示文字，判题机严格比对 stdout，任何多余字符均会导致 WA。",
            },
        ],
    })
}
