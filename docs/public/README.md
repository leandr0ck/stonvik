# Stonvik

Stonvik es un workflow manager local y repository-native para coordinar trabajo de desarrollo entre humanos, agentes y CI. El repositorio conserva el estado durable, la evidencia y las decisiones; cada actor participa mediante la CLI y contratos JSON/YAML estables.

## Instalación

Requisitos: Node.js 20 o superior.

```bash
npm install --save-dev stonvik
npx stonvik init
npx stonvik --help
```

Si el paquete está instalado globalmente, se puede usar `stonvik` en lugar de `npx stonvik`.

## Flujo mínimo

```text
capture → prepare → ready → start → doing → report
→ verify → review → done
```

Un reporte `completed` no cierra el Work. La verificación determinista y el review independiente son gates separados.

## Guías

- [Quickstart](./quickstart.md): primer Work directo y ruta spec-first.
- [Referencia de CLI](./cli-reference.md): comandos, opciones, salidas y errores.
- [Contratos](./contracts.md): formatos de actores, handoffs, reportes y configuración.
- [Integración de agentes](./agent-integration.md): protocolo para cualquier agente externo.
- [CI](./ci.md): uso desde pipelines y procesos automatizados.
- [Seguridad y confianza](./security.md): claims, paths, identidad y límites.
- [Migración](./migration.md): transición desde `run`, `triage` e `implement`.

## Qué se versiona

Se versionan los directorios `product/` y `features/`, incluidos manifests, especificaciones, notas y receipts. `.stonvik/runtime/` contiene claims, leases y otros datos efímeros; Stonvik lo agrega al `.gitignore` durante `init`.

## Participantes

- **Humanos:** capturan intención, deciden routing y hacen review.
- **Agentes:** consumen handoffs, modifican archivos de trabajo y reportan resultados.
- **CI/procesos:** ejecutan verificaciones o importan evidencia con el mismo contrato.

Ningún actor necesita conocer Pi, Spec Flow u otro runtime para usar el workflow neutral.

## Compatibilidad

`run`, `triage` e `implement --engine pi-spec-flow` permanecen como rutas de compatibilidad durante la migración. Para nuevas integraciones, usar `prepare`, `next`, `handoff`, `work start`, `work report`, `verify` y `work review`.

La identidad de un actor (`--actor` o `STONVIK_ACTOR`) es procedencia declarada, no autenticación.
