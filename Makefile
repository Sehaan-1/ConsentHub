.PHONY: install dev build test lint verify verify-domain up down

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

up:
	docker compose up --build

down:
	docker compose down
