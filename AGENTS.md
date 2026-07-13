# Forgium — instrucciones para agentes de código

## Propósito y fuentes de verdad

Forgium es un motor de workflow nativo del repositorio para agentes de
desarrollo. El estado durable vive en archivos del repositorio; los agentes no
deben tratar el historial de conversación como fuente de verdad.

Lee primero [docs/README.md](docs/README.md). Dentro de la documentación del
repositorio, usa este orden de precedencia:

1. ADRs en `docs/adr/`.
2. Planes en `docs/plans/`.
3. `loop-technical-spec.md` (especificación histórica de base).
4. `README.md`.
5. Código existente.

Los ADRs son normativos cuando contradicen la especificación histórica o el
código. Señala la divergencia y actualiza la documentación pertinente al
implementar una decisión. No inventes arquitectura, estados o transiciones que
no estén documentados; pide aclaración si falta una decisión necesaria.

## Reglas de implementación

- Haz cambios pequeños, focalizados y compatibles con el comportamiento
  existente salvo que la tarea pida explícitamente un cambio de contrato.
- Conserva la lógica de dominio y las transiciones de estado deterministas; no
  introduzcas una llamada a LLM donde el código normal pueda validar, ordenar,
  leer o mover estado.
- Usa las APIs del repositorio para transiciones y escrituras. No manipules
  directorios de estado ad hoc desde comandos de CLI.
- Escribe archivos de estado de forma atómica y valida su esquema antes de
  persistirlos.
- No agregues dependencias de producción, renombres públicos ni cambios de
  estructura amplios sin justificación explícita y actualización de docs/ADR.
- No descartes, reviertas ni reformatees cambios ajenos del working tree.

## Invariantes de dominio

- Un Inbox contiene intención cruda; no es una cola ejecutable.
- Un Draft en `features/draft/` puede estar incompleto y nunca debe ser
  seleccionado para ejecución.
- Una Feature en `features/ready/` siempre necesita un `manifest.yaml` válido
  con título, objetivo y al menos un criterio de aceptación.
- Las transiciones de Feature se representan moviendo su directorio completo.
  No permitas `doing → done`: debe pasar por `review` y tener una decisión
  registrada.
- El estado durable y la evidencia versionable pertenecen al repositorio. Los
  leases y logs locales son efímeros y viven bajo `.forgium/runtime/`.
- Un implementador no puede autoaprobar su trabajo. `done` requiere review y
  receipts/evidencia según los ADRs.
- Git es opcional para ejecutar Forgium; si existe, solo ayuda a descubrir la
  raíz del proyecto.

## Convenciones de código

- El proyecto usa Node.js, TypeScript estricto y módulos `NodeNext`.
- Mantén imports ESM con extensión `.js`, siguiendo los archivos existentes.
- Preferí funciones y tipos pequeños, explícitos y testeables sobre abstracciones
  genéricas prematuras.
- Al cambiar una conducta, agrega o actualiza tests de Vitest en
  `src/core/__tests__/`.
- Mantén la salida humana de CLI concisa; las integraciones deben poder usar
  salida JSON estructurada cuando esté disponible.

## Desarrollo y validación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Ejecuta al menos los checks afectados por el cambio y ejecuta los cuatro antes
de declarar una implementación terminada, salvo que expliques por qué alguno no
puede ejecutarse. No ocultes tests fallidos ni cambies tests solo para acomodar
una implementación incorrecta.

## Documentación y cierre

- Actualiza un ADR o plan si cambian una decisión, contrato, estado, comando o
  artefacto persistido.
- No copies ADRs extensos en este archivo; enlázalos desde aquí o desde docs.
- Al cerrar, indica archivos cambiados, decisiones relevantes y comandos de
  verificación ejecutados con su resultado.
