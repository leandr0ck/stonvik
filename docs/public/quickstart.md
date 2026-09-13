# Quickstart

Este ejemplo muestra la ruta directa. Los identificadores se indican como `<...>` para que cada cliente use los valores que devuelve su repositorio.

## 1. Inicializar y capturar intención

```bash
npx stonvik init
npx stonvik capture "Agregar exportación CSV" --source human:terminal
```

La salida JSON permite obtener el ID sin interpretar texto humano:

```bash
npx stonvik --json capture "Agregar exportación CSV" --source human:terminal
```

Copiar el valor `id` de la respuesta como `<inbox-id>`.

## 2. Preparar el Work

```bash
npx stonvik prepare <inbox-id> \
  --route direct \
  --actor human:lean
```

`prepare` registra la decisión de routing y crea un Work `implementation` en `features/ready/`. Si los riesgos, tamaño o ambigüedad no permiten la ruta directa, usar `--route spec-first` o una excepción explícita del rol autorizado.

## 3. Seleccionar y reclamar

```bash
npx stonvik --json next
npx stonvik work start <work-id> \
  --actor agent:codex \
  --run-id agent-codex-001
```

`work start` crea un claim local y mueve el directorio completo de `ready` a `doing`. Un segundo actor no puede reclamar el mismo Work mientras el claim siga activo.

## 4. Entregar el handoff

```bash
npx stonvik handoff <work-id> --format json > handoff.json
```

El handoff contiene objetivo, aceptación, restricciones, verificación, referencias y el protocolo de reporte. Generarlo no modifica el estado.

## 5. Ejecutar fuera de Stonvik y reportar

El agente modifica solo los archivos del repositorio que necesita el Work. No edita manifests, receipts, claims ni directorios de estado.

Cuando termina, crea un reporte JSON:

```json
{
  "schemaVersion": 1,
  "actor": {
    "type": "agent",
    "name": "codex",
    "role": "implementer"
  },
  "outcome": "completed",
  "summary": "Implementé la exportación CSV y dejé los tests actualizados.",
  "artifacts": [],
  "evidence": []
}
```

Se importa mediante la CLI:

```bash
npx stonvik work report <work-id> --receipt result.json
```

`completed` significa solamente que el actor declara haber terminado. El Work todavía está en `doing`.

## 6. Verificar y revisar

```bash
npx stonvik verify <work-id>
npx stonvik work review <work-id> \
  --actor human:reviewer \
  --decision approved \
  --summary "La implementación satisface el contrato."
```

`verify` ejecuta los comandos definidos en el manifest. Solo un review aprobado, hecho por un actor distinto del ejecutor declarado, puede mover el Work a `done`.

## Ruta spec-first

Para trabajo ambiguo o riesgoso:

```bash
npx stonvik prepare <inbox-id> --route spec-first --actor human:lean
npx stonvik work start <spec-work-id> --actor agent:claude
npx stonvik work report <spec-work-id> --receipt spec-result.json
npx stonvik verify <spec-work-id>
npx stonvik work review <spec-work-id> \
  --actor human:product-owner \
  --decision approved
npx stonvik work create-from-spec <spec-work-id>
```

La última operación crea un Work `implementation` nuevo en `ready`, enlazado mediante `specificationRef`. No inicia ningún ejecutor.

## Comprobar el repositorio

```bash
npx stonvik --json status
npx stonvik --json validate
```

Los errores estructurados se emiten como JSON en `stderr` cuando se usa `--json`; el proceso devuelve un exit code distinto de cero.
