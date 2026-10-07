"""Allow the unprivileged judge UID to execute copied Python files on amd64."""
from pathlib import Path

source = Path('/home/judge/src/core/judge_client/judge_client.cc')
text = source.read_text()
needle = '\t// The judge process drops root before exec; copied files inherit umask 0077.'
marker = '// HOJ amd64 Python copied runtime permissions'
if marker not in text:
    start = text.index('#ifdef __aarch64__\n' + needle)
    text = text[:start] + '''#ifdef __x86_64__
	// HOJ amd64 Python copied runtime permissions: do not chmod bind-mounted /lib.
	execute_cmd("/bin/chmod -R a+rX %s/usr %s/etc", work_dir, work_dir);
#endif
''' + text[start:]
    source.write_text(text)
