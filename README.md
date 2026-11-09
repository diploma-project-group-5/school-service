# school-service

Дані закладу «Лад»: профіль, основні дзвінки, класи, предмети, вчителі, навчальний план, журнал дій і знімок даних для `timetable-service` (специфікація, розділи 03, 04, 09, 12).

Node 24 · TypeScript 6.0 · Fastify 5 · Kysely + PostgreSQL 16 · @platformatic/kafka · jose · Vitest 4.1 + Testcontainers.

## API

Усі маршрути `/api/v1/school/*` — лише з токеном клієнта `web`, роллю `scheduler` і непорожнім `school_id`. Заклад береться з токена, у шляхах його немає. Без токена або з недійсним — 401, токен `sysadmin` чи без `school_id` — 403, чужий або неіснуючий ресурс — 404. Помилки — `application/problem+json` з полем `code`.

| Маршрут | Що робить |
|---|---|
| `GET` `PUT /school` | профіль: `lessons_per_day` (1–10), `saturday`, `shelter_capacity` (паспортна місткість), `non_teaching_staff`, `shelter_seats` (облаштовані місця); PUT частковий, `name` і `snapshot_version` лише для читання. До приходу `school.registered` GET повертає 200 з порожнім профілем |
| `GET` `PUT /bells` | основний розклад дзвінків `[{ lesson_no, start: "HH:MM", end }]`; PUT замінює цілком; уроки не перетинаються |
| `GET` `POST /classes`, `PUT` `DELETE /classes/{id}` | класи: `name`, `students` (0–60), `in_person_priority`; DELETE — архівування (`archived_at`), рядки плану класу видаляються; назва активного класу унікальна (409 `name_taken`) |
| `GET` `POST /subjects`, `PUT` `DELETE /subjects/{id}` | предмети: `name`, `short_name`, `education_area` (9 галузей), `not_in_shelter`; DELETE — архівування, 409 `in_curriculum`, якщо предмет у плані |
| `GET` `POST /teachers`, `PUT /teachers/{id}` | вчителі: `label` (підпис, унікальний — 409 `label_taken`), `weekly_hours_limit`, `unavailable_days`; `teacher_no` видається по черзі в закладі |
| `DELETE /teachers/{id}` | етап 2 · видалення даних вчителя (ст. 15): підпис стирається, лишається «Вчитель #N»; 409 `in_curriculum`, якщо вчитель у плані |
| `GET /teachers/{id}/export` | етап 2 · експорт (ст. 8): дані вчителя, рядки плану, записи журналу над ним; сам експорт пишеться в журнал |
| `GET` `PUT /curriculum` | план `[{ class_id, subject_id, teacher_id, hours_per_week }]`; PUT замінює цілком; посилання лише на активні класи й предмети та невидалених вчителів (422 `unknown_reference`) |
| `GET /audit?from=&to=&target=` | журнал за період (дати включно, Europe/Kyiv) і, за потреби, над одним ідентифікатором; від нових до старих |
| `GET /health` | 200 `{ "status": "ok" }` або 503; через шлюз не відкривається |

Внутрішній маршрут — на **окремому порту** (`INTERNAL_PORT`, 3102), на який шлюз не веде; на публічному порту `/api/v1/school/internal/*` дає 404:

| Маршрут | Що робить |
|---|---|
| `GET /internal/v1/schools/{schoolId}/snapshot` | повний знімок даних закладу одним моментом (REPEATABLE READ): `snapshot_version`, профіль, дзвінки, усі класи, предмети й вчителі (з `archived_at` / `deleted_at`), план |

Поля відповідей збігаються з типами `frontend/src/api/types.ts`.

## Зміни даних і події

Кожна зміна даних закладу — одна транзакція:

1. `snapshot_version + 1` у профілі (рядок профілю блокується, тож зміни одного закладу йдуть по черзі, а `teacher_no` не повторюється);
2. запис журналу дій (без прізвищ — лише ідентифікатори);
3. подія `school.data.changed` в outbox.

Зміна, яка нічого не змінює, не збільшує версію і не пише подію.

| Топік | Напрям | Дані |
|---|---|---|
| `school.data.changed` | публікує | `{ snapshot_version, changes: [{ entity, op, id?, teacher_no? }] }`; `entity`: profile, bells, class, subject, teacher, curriculum; `op`: created, updated, archived, deleted, replaced. Для видаленого вчителя — `teacher_no`, щоб timetable поставив «Вчитель #N» у копіях підписів |
| `school.registered` | слухає | профіль з назвою (`snapshot_version` не змінюється) і запис журналу «заклад зареєстровано» |
| `audit.recorded` | слухає | запис журналу про дію в timetable: `{ at, actor, action, target, details }` |

Конверт — `contracts/schemas/events/envelope.v1.json`, ключ партиції — `school_id`. Relay відправляє outbox у Kafka (ідемпотентний продюсер, acks=all). Консюмер обробляє по одному повідомленню, пише `event_id` в inbox і пропускає повтори; технічна помилка — 3 спроби з паузою, далі `<топік>.dlq`; зламана подія (не JSON, не той конверт, невідомий MAJOR `schema_version`) — одразу в DLQ. Offset підтверджується після обробки або запису в DLQ.

## База даних

Усі таблиці (`school_profile`, `bells`, `classes`, `subjects`, `teachers`, `curriculum`, `audit_log`, `outbox`, `inbox`) мають `school_id` першим у первинному ключі й `FORCE ROW LEVEL SECURITY`. Заклад задається лише через `set_config('app.school_id', …, true)` у транзакції.

| Роль | Що може |
|---|---|
| `school_owner` | власник таблиць, лише міграції (`make migrate`) |
| `school_app` | DML свого закладу; журнал — лише SELECT, INSERT (незмінний); outbox — лише INSERT |
| `school_relay` | SELECT, UPDATE outbox усіх закладів |
| `school_maint` | SELECT, DELETE outbox, inbox і журналу всіх закладів (щоденна чистка: журнал — 1 рік, outbox та inbox — 7 днів) |

Ролі й базу створює `db-init` у репозиторії `platform`: потрібен рядок `service_database school` у `db-init/init.sh` і паролі `SCHOOL_OWNER_DB_PASSWORD`, `SCHOOL_APP_DB_PASSWORD`, `SCHOOL_RELAY_DB_PASSWORD`, `SCHOOL_MAINT_DB_PASSWORD` у `.env.example` і `docker-compose.yml` platform.

> **Тимчасово до появи пакета `@lad/db`.** `withSchool`, outbox, inbox і relay поки живуть у `src/db` і `src/kafka` (так само, як у tenant-service). Коли пакет з'явиться, вони замінюються імпортом з нього.

## Локальна розробка

Потрібні Node 24 (`node -v`) і запущений Docker.

```bash
cp .env.example .env
make install
make migrate
make dev
```

Перед цим у `platform` має працювати `make up`. Сервіс слухає `:3002` (шлюз веде на нього `http://localhost/api/v1/school/...`) і `:3102` для `/internal/v1`. Токен укладача для curl: у `platform` виконати `make token`.

## Тести

```bash
make test
```

Vitest сам піднімає PostgreSQL 16.15 і Kafka 4.3.2 у контейнерах (Testcontainers) — потрібен лише запущений Docker. Уже запущені сервери: `TEST_PG_ADMIN_URL=postgres://postgres:…@localhost:5432/postgres`, `TEST_KAFKA_BROKERS=localhost:29092`; без Docker тест зі справжньою Kafka пропускається з `TEST_KAFKA=off`.

| Файл | Що перевіряє |
|---|---|
| `test/auth.test.ts` | 401/403 на всі види поганих токенів, sysadmin → 403, внутрішні маршрути на публічному порту → 404, токен не в лозі |
| `test/profile.test.ts` | порожній профіль, часткове оновлення, `snapshot_version`, подія й журнал, дзвінки та їх валідація |
| `test/data.test.ts` | класи, предмети, вчителі (`teacher_no` при паралельних запитах, видалення й експорт), план, ізоляція закладів |
| `test/audit-snapshot.test.ts` | журнал (період за Києвом, фільтр, незмінність), внутрішній знімок |
| `test/events.test.ts` | `school.registered`, `audit.recorded`, inbox, конверт, консюмер (3 спроби → DLQ), relay, щоденна чистка |
| `test/db.test.ts` | RLS у кожній таблиці, права app/relay/maint, відсутність BYPASSRLS, FORCE і `school_id` у ключі, міграції up/down |
| `test/kafka.test.ts` | справжня Kafka: relay → топік, консюмер → профіль, зламана подія → DLQ |
| `test/units.test.ts` | конфігурація, перевірка дзвінків |

Покриття: поріг 90% рядків і функцій, 80% гілок — нижче CI не пропустить.

Правило: нова поведінка — новий тест у тій самій гілці; знайдена помилка — спершу тест, що її відтворює.

## Команди

| Команда | Що робить |
|---|---|
| `make install` | залежності точно за `package-lock.json` |
| `make dev` | сервіс з перезапуском при змінах |
| `make migrate` | міграції бази school |
| `make test` | усі тести з покриттям |
| `make check` | lint + типи + тести, як у CI |
| `make build` | зібрати `dist/` |
| `make docker-build` | зібрати образ |
