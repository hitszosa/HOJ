# HUSTOJ 判题与账号适配源码

此目录来自 2026-10-07 从现用服务器取回的源码快照，保留本平台已部署的判题与账号适配修改。`snapshot.json` 记录原始文件和入库文件的 SHA-256。未找到可验证的上游 commit，因此不将这份快照冒充为上游某个版本。

仅包含评测器源码、账号适配器依赖的 PHP 文件、语言文本和初始化表结构；没有原生 OJ 页面。数据库与 SMTP 密码已从 PHP 模板移除，容器启动时从私有环境变量生成数据库配置。

上游：[zhblue/hustoj](https://github.com/zhblue/hustoj)。许可证见 `LICENSE`，GPL v2。此目录中现用服务器的 Python 沙箱权限修补已保留；`deploy/remote/patch-python-runtime.py` 是可重复运行的补丁步骤。
