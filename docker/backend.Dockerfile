FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY backend backend
COPY contract contract
RUN mvn -q -f backend/pom.xml package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/backend/consenthub-api/target/consenthub-api-*.jar /app/consenthub-api.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/consenthub-api.jar"]
