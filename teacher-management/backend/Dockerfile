ARG RUNTIME_IMAGE=harbor.osa.moe/grader/backend-runtime:bookworm-amd64
FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY bin/grader-backend /usr/local/bin/grader-backend
COPY bin/register_oauth_client /usr/local/bin/register_oauth_client
COPY bin/migrate_upload_objects /usr/local/bin/migrate_upload_objects
USER 10001:10001
EXPOSE 8000
ENV BIND=0.0.0.0:8000 RUST_LOG=info
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8000/healthz || exit 1
ENTRYPOINT ["grader-backend"]
CMD ["serve"]
