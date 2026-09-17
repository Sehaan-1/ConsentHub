# ConsentHub backend — multi-stage build.
# Stage 1: Maven build (same JDK as CI and the parent pom: Temurin 21).
# Stage 2: JRE-only runtime. The project compiles with Java 21 (backend/pom.xml
#          <java.version>21</java.version> and CI uses temurin 21), so the
#          runtime must be 21 as well — a 17 runtime cannot load the classes.
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY backend backend
COPY contract contract
RUN mvn -q -f backend/pom.xml package -DskipTests

# curl is needed by the container healthcheck (the JRE image ships no
# HTTP client).
FROM eclipse-temurin:21-jre
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r consenthub \
    && useradd -r -g consenthub -d /app -s /usr/sbin/nologin consenthub
WORKDIR /app
COPY --from=build /workspace/backend/consenthub-api/target/consenthub-api-*.jar app.jar
RUN chown -R consenthub:consenthub /app
USER consenthub
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
    CMD curl -fsS http://127.0.0.1:8080/actuator/health || exit 1
ENTRYPOINT ["java", "-jar", "app.jar"]
