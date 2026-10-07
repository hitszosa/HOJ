"""Correct GETREGSET's iovec ABI and aarch64 syscall tables in the local image.

Reference: https://man7.org/linux/man-pages/man2/ptrace.2.html
This keeps ptrace/chroot/resource limits enabled.
"""
from pathlib import Path
import platform
import re

if platform.machine() != 'aarch64':
    raise SystemExit('This local image patch is for aarch64 only')
root = Path('/home/judge/src/core/judge_client')
source = root / 'judge_client.cc'
text = source.read_text()
assert '#define REG_SYSCALL regs[18]' in text
text = text.replace('#include <sys/user.h>', '#include <sys/user.h>\n#include <sys/uio.h>')
text = text.replace('#define REG_SYSCALL regs[18]', '#define REG_SYSCALL regs[8]')
start = text.index('#ifdef __aarch64__\n\t\tcall_id=ptrace(PTRACE_GETREGS')
end = text.index('#endif', start) + len('#endif')
text = text[:start] + '''#ifdef __aarch64__
        struct iovec register_set = { &reg, sizeof(reg) };
        if (ptrace(PTRACE_GETREGSET, pidCur, (void *)NT_PRSTATUS, &register_set) == -1) {
            print_runtimeerror(infile+prelen, "Cannot read aarch64 registers");
            ACflg = OJ_RE;
            kill(pidCur, SIGKILL);
            break;
        }
        call_id = (unsigned int)reg.REG_SYSCALL;
        if (call_id >= call_array_size) {
            print_runtimeerror(infile+prelen, "System call outside whitelist range");
            ACflg = OJ_RE;
            kill(pidCur, SIGKILL);
            break;
        }
#endif''' + text[end:]
# Apply the existing execve restriction to the correct ARM64 syscall.
text = text.replace('if (lang==3)call_counter[220]= 100;\n\telse call_counter[220]= 1;',
                    'call_counter[SYS_execve]= (lang == LANG_PYTHON ? 8 : 1);')
source.write_text(text)

common = '''read write close fstat newfstatat openat readlinkat lseek mmap munmap
 mprotect brk set_tid_address set_robust_list rseq prlimit64 getrandom futex
 rt_sigaction rt_sigprocmask rt_sigreturn exit exit_group clock_gettime ioctl
 getpid gettid getuid geteuid getgid getegid uname faccessat faccessat2 fcntl
 statx execve pread64 readv writev getcwd getrlimit dup dup3'''.split()
python = common + '''getdents64 sigaltstack mremap sysinfo getrusage gettimeofday
 clock_getres madvise prctl sched_getaffinity socket connect'''.split()
java = python + '''clone clone3 sched_yield sched_getparam sched_getscheduler
 sched_setscheduler sched_setaffinity clock_nanosleep nanosleep ftruncate
 unlinkat mkdirat flock fchdir socket connect statfs fstatfs flistxattr
 restart_syscall'''.split()
header = root / 'okcalls_aarch64.h'
text = header.read_text()
for name, calls in [('LANG_CV', common), ('LANG_YV', python), ('LANG_JV', java)]:
    entries = ','.join('SYS_' + syscall for syscall in dict.fromkeys(calls))
    text, count = re.subn(r'int ' + name + r'\[CALL_ARRAY_SIZE\]\s*=\s*\{[^}]*\};',
                         f'int {name}[CALL_ARRAY_SIZE] = {{0,{entries},511,0}};', text)
    assert count == 1, name
header.write_text(text)
