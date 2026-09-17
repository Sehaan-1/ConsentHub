.PHONY: install dev build test lint verify verify-domain boot up up-prod down

install:
	corepack pnpm install

dev:
	corepack pnpm dev

build:
	corepack pnpm build

test:
	corepack pnpm test

lint:
	corepack pnpm lint

verify:
	corepack pnpm build
	mvn -q -f backend/pom.xml verify

verify-domain:
	mvn -q -pl backend/consenthub-domain -am verify

# One-command boot: .env.example -> .env (when missing) + docker compose up --build.
boot:
	./scripts/boot.sh

up:
	docker compose up --build

# Production-flavoured stack: nginx-served frontends, compiled BFF/sandbox.
up-prod:
	docker compose -f docker-compose.yml -f compose.prod.yml up --build

down:
	docker compose down
