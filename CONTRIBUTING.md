# Contributing to MADEPROOF

Спасибо, что хочешь помочь MADEPROOF стать лучше. Это открытый проект, и
любой вклад — код, документация, баг-репорт, идея — ценен.

> English speakers: contributions in English are welcome. The maintainer is
> bilingual; issue/PR threads may be answered in either language.

## Code of Conduct

Участие в проекте регулируется [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Присоединяясь, ты соглашаешься его соблюдать.

## Что можно делать

- **Сообщать о багах** — через GitHub Issues (шаблон `bug_report`).
- **Предлагать фичи** — через GitHub Issues (шаблон `feature_request`).
- **Править код** — fork → branch → PR (правила ниже).
- **Править документацию** — README, docs/, комментарии — точно так же через PR.
- **Задавать вопросы** — в Discussions, если они включены, или в Issue с меткой `question`.

## Быстрый старт для разработчика

```bash
# Требования: Node.js >= 22.16, (PostgreSQL >= 15 для прод-режима, SQLite для dev)
git clone https://github.com/castefeudal/madeproof.git
cd madeproof
npm ci            # установка зависимостей (синхронизирует lock-файл)
npm run build     # компиляция TypeScript -> dist/
npm test          # unit + integration + security + e2e
```

Локальный запуск (SQLite, без внешних сервисов):

```bash
cp .env.example .env
npm run start     # API + Web на http://127.0.0.1:3210
```

## Ветки и коммиты

- Ветка по умолчанию — `main`. Прямые пуши в `main` только для мейнтейнера.
- Для изменений создавай ветку: `fix/describe-bug`, `feat/describe-feature`,
  `docs/describe-change`, `build/describe-change`.
- Коммиты — в conventional-стиле, чтобы changelog генерировался автоматически:

  ```
  fix: описание исправления
  feat: описание новой возможности
  docs: описание правки документации
  build: изменения сборки/CI/зависимостей
  test: изменения тестов
  refactor: рефакторинг без изменения поведения
  ```

## Чек-лист перед PR

- [ ] `npm run lint` — без ошибок
- [ ] `npm run format:check` — форматирование соблюдено
- [ ] `npm run typecheck` — типы сходятся
- [ ] `npm run test` — все тесты зелёные (unit, integration, security, e2e)
- [ ] Добавлен/обновлён тест на изменение (если меняется поведение)
- [ ] Обновлена документация, если меняется публичный API/поведение
- [ ] Запись в `CHANGELOG.md` под `[Unreleased]` (если заметное изменение)

CI прогонит те же проверки на каждый PR — зелёный CI обязателен для merge.

## Архитектурные принципы (обязательны для кода)

Прежде чем менять код, прочитай [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Критичные инварианты, которые нельзя нарушать:

1. **VERIFIED — только после реальной проверки.** Никакой код-пат не должен
   превращать «мы не смогли проверить» в «проверено». Инфраструктурная ошибка
   = `ERROR`, никогда не `VERIFIED`.
2. **Control plane не исполняет код.** `apps/api` и `apps/web` никогда не
   импортируют и не запускают команды целевого проекта. Исполнение — только
   в `apps/runner` (изолированная песочница).
3. **Runner не имеет доступа к БД.** Runner общается с API только наружу,
   по одностороннему поллингу, с кредой `mpr_...`.
4. **Self-reported evidence — не доказательство.** Подтверждение «я сделал»
   никогда не принимается как самостоятельное proof для VERIFIED.
5. **Всё хэшируется и неизменяемо.** Receipt'ы и завершённые run'ы нельзя
   переписать.
6. **Sandbox fail-closed.** Если сильная изоляция (Bubblewrap) недоступна —
   runner отказывается работать, а не ослабляет защиту (в проде).

## Тестирование

- Unit-тесты: `npm run test:unit` — быстрые, без I/O.
- Integration: `npm run test:integration` — worker/runner/очередь.
- Security: `npm run test:security` — границы, песочница, авторизация.
- E2E: `npm run test:e2e` — полный поток.
- Browser: `npm run test:browser` — требует Chromium (CDP).

Тесты лежат в `tests/` и запускаются из `dist/` после сборки
(`node --test dist/tests/**/*.test.js`).

## Лицензия

Проект распространяется под [MIT License](LICENSE).
