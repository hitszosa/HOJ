from __future__ import annotations

import os
import subprocess

from fastapi import HTTPException


def write_test_files(pid,tests):
    """先清掉该题旧的编号测试点再整体重写，重试不会遗留多余测试。"""
    container=os.environ.get('COURSE_CONTAINER','hustoj')
    directory=f'/home/judge/data/{int(pid)}'
    try:
        subprocess.run(['docker','exec',container,'mkdir','-p',directory],check=True,timeout=10)
        subprocess.run(['docker','exec',container,'find',directory,'-maxdepth','1','-type','f',
                        '-regextype','posix-extended','-regex','.*/[0-9]+\\.(in|out)','-delete'],check=True,timeout=10)
        for n,test in enumerate(tests,1):
            for extension,field in [('in','input'),('out','output')]:
                target=f'{directory}/{n}.{extension}'
                subprocess.run(['docker','exec','-i',container,'tee',target],input=test[field],text=True,stdout=subprocess.DEVNULL,check=True,timeout=10)
    except (OSError,subprocess.SubprocessError):
        raise HTTPException(503,'测试点写入判题机失败，本次发布未放开可见，可安全重试')
