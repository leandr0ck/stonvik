# Uso desde CI y procesos

CI puede participar como cualquier otro actor. La identidad recomendada es `ci:<provider>` o `process:<runner>`.

## Verificación de un Work existente

Si un Work ya tiene un reporte externo y solo necesita verificación:

```bash
set -euo pipefail
stonvik --root . --json validate
stonvik --root . --json verify "$WORK_ID" > verification.json
```

`verify` crea un verification receipt y, si pasa, mueve el Work a `review`. El pipeline no debe mover directorios ni editar receipts con `mv`, `cp` o scripts propios.

## CI como ejecutor

```bash
set -euo pipefail

WORK_ID="${WORK_ID:?pass a Work ID}"
RUN_ID="ci-${CI_PIPELINE_ID:-local}"

stonvik work start "$WORK_ID" \
  --actor ci:github \
  --run-id "$RUN_ID"
stonvik handoff "$WORK_ID" --format json > handoff.json

# El pipeline ejecuta aquí los comandos de build/test del proyecto.
# Al terminar, escribe result.json con ExternalExecutionReport.
stonvik work report "$WORK_ID" --receipt result.json --run-id "$RUN_ID"
stonvik verify "$WORK_ID"
```

El report debe declarar el mismo actor y, si se usa, el mismo `runId` del claim. Los artifacts indicados deben existir antes de importar el report.

## Reglas para pipelines

- Usar `--json` para integraciones; no parsear salida humana.
- Fallar el job ante un exit code distinto de cero.
- Publicar `result.json`, `handoff.json` y los receipts como artifacts del pipeline cuando se necesite auditoría externa.
- No ejecutar dos jobs de verificación sobre el mismo Work simultáneamente.
- No guardar tokens, secretos o credenciales en `summary` ni `details`.
- Hacer que el código que genera el reporte sea reproducible y versionado con el repositorio.
