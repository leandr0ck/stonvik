# Stonvik

Stonvik es un workflow manager local y repository-native para coordinar trabajo de desarrollo entre humanos, agentes y CI. El repositorio conserva el estado durable, la evidencia y las decisiones; cada actor participa mediante la CLI y contratos JSON/YAML estables.

## Instalación

Requisitos: Node.js 20 o superior.

```bash
npm install --save-dev stonvik
npx stonvik init
npx stonvik --help
```

Para instalar directamente desde Git con Bun, permite el script de build del
paquete (Bun no ejecuta scripts de dependencias Git por defecto):

```bash
bun add --trust github:leandr0ck/stonvik
# o, si ya está declarado en package.json:
bun pm trust stonvik && bun install
```

El paquete ejecuta `prepare` para compilar `dist/` durante la instalación Git.

## Flujo

```text
capture → triage → define → ready
ready → start → doing → report → verify → review → ship → done
```

- **Capture:** guarda la intención cruda en Inbox.
- **Triage:** registra si el trabajo sigue una ruta directa, necesita una spec o necesita un ADR.
- **Define:** crea el Work ejecutable con título, objetivo, aceptación y verificación.
- **Implement:** un actor externo decide y ejecuta su propio proceso; Stonvik solo registra el reporte.
- **Verify:** ejecuta los checks declarados en el manifest.
- **Review:** un actor distinto registra una decisión independiente.
- **Ship:** convierte un Work aprobado en `done`.

Triage no ejecuta nada y una spec o ADR no tiene formato impuesto por Stonvik. Son documentos del usuario: Stonvik solo registra sus rutas, comprueba que existan y evita que apunten al estado interno del workflow.

## Guías

- [Quickstart](./quickstart.md): ciclo completo con un Work.
- [Referencia de CLI](./cli-reference.md): comandos, opciones, salidas y errores.
- [Contratos](./contracts.md): manifests, actores, referencias y reportes.
- [Integración de agentes](./agent-integration.md): protocolo para cualquier agente externo.
- [CI](./ci.md): uso desde pipelines y procesos automatizados.
- [Seguridad y confianza](./security.md): claims, paths, identidad y límites.

## Qué se versiona

Se versionan `product/` y `features/`, incluidos manifests, documentos de usuario, notas, provenance y receipts. `.stonvik/runtime/` contiene claims efímeros y se agrega al `.gitignore` durante `init`.

## Principios

- La intención no es ejecución: solo un Work definido puede seleccionarse.
- El manifest es el contrato ejecutable; los documentos asociados siguen siendo libres.
- Las transiciones mueven el directorio completo del Work.
- Un implementador nunca puede aprobar su propio trabajo.
- La identidad declarada (`--actor` o `STONVIK_ACTOR`) es procedencia, no autenticación.
- Ningún actor necesita conocer Pi, Spec Flow u otro runtime para participar.
