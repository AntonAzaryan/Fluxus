## 1. Правка спек

- [x] 1.1 В `openspec/specs/time-system/spec.md` заменить требование TIME-5 на версию из delta-спеки (два сценария вместо одного, запрет по классам систем снят)
- [x] 1.2 В `openspec/specs/snapshot-rewind/spec.md` дописать к REW-9 предложение про область действия exempt-списка; текст исключения не менять

## 2. Проверка

- [x] 2.1 `openspec validate --specs --strict` — 14 capability проходят
- [x] 2.2 `openspec validate --change timescale-applicability --strict`
- [x] 2.3 Убедиться, что TIME-4, TIME-6, TIME-9 не затронуты
