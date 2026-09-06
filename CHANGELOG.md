# Changelog

Все заметные изменения MADEPROOF — в этом файле.
Формат — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
версионирование — [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Добавлено
- Публичный релиз-фундамент: MIT License, CONTRIBUTING, CODE_OF_CONDUCT,
  шаблоны issues/PR, changelog.
- Публикация на npm (CI-driven).

## [0.1.0] — 2026-09-06

### Добавлено
- Первый публичный релиз MADEPROOF.
- Evidence-first платформа верификации делегированной ИИ-работы:
  - Контракты и критерии приёмки (обязательные/опциональные, confidence).
  - Durable очередь верификации в PostgreSQL (202 = queued, leases,
    reclaim после crash).
  - Runner с сильной Bubblewrap-изоляцией: non-root, пустое окружение,
    сеть off по умолчанию, лимиты ресурсов, kill process-tree по таймауту.
  - Типизация evidence по происхождению: `MACHINE`, `BROWSER`, `COMMAND`,
    `SELF_REPORTED`; самопроверки никогда не дают VERIFIED.
  - Вердикты: `VERIFIED` только когда каждый обязательный критерий реально
    PASSED; иначе `FAILED`/`ERROR`/`CANCELLED` — без ложных успехов.
  - Неизменяемые hash-chained receipt'ы, pinned к run и контракту.
  - REST API (Fastify-совместимый HTTP) с OpenAPI-спекой, RBAC,
    rate-limit, audit log, durable очередью.
  - MCP-сервер: 15 инструментов полного жизненного цикла верификации.
  - CLI и typed SDK.
  - SQLite (dev/demo) и PostgreSQL (production) режимы.
- 32 автотеста: unit 13, integration 8, security 11 — все зелёные.
- CI: typecheck + lint + format + тесты на каждый push/PR.

[Unreleased]: https://github.com/castefeudal/madeproof/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/castefeudal/madeproof/releases/tag/v0.1.0
