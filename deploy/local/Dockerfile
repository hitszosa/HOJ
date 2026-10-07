FROM hustoj-dev:latest
COPY patch-arm64.py /opt/hoj-patch-arm64.py
RUN python3 /opt/hoj-patch-arm64.py && \
    cd /home/judge/src/core/judge_client && make && \
    install -m 755 judge_client /usr/bin/judge_client
