# Plan 0008: Regresión funcional basada en criterios de aceptación

**Estado:** Propuesto — requiere aprobación antes de implementación  
**Fecha:** 2026-07-13  
**Aplica a:** CLI pública y ADR 0002–0006. Reemplaza el alcance E2E de
[Plan 0007](0007-test-strategy.md).

## Problema

`lifecycle-e2e.test.ts` no es una experiencia de usuario ni prueba un criterio
observable: invoca APIs internas, usa un adapter que declara éxito sin cambiar
nada y aprueba la Feature sin comprobar evidencia. Es solo un happy path parcial
de transiciones; no sirve como criterio de aceptación de la herramienta.

La regresión debe demostrar con procesos reales de `forgium` que los comandos
públicos producen estado durable válido, que la ejecución logra un efecto
observable y que Forgium comprueba dicho efecto antes del review. Los tests son
la evidencia automatizada del contrato de Forgium. Para una Feature de usuario,
no sustituyen la revisión y evidencia adicional exigidas por ADR 0004.

## Objetivo y definición de terminado

La regresión de aceptación cubre este recorrido completo:

```text
init → capture → triage/edit → promote → run --engine …
     → criterio observable verificado → review explícito → done → validate
```

Un recorrido exitoso demuestra todos estos hechos:

1. Solo comandos públicos cambian estado durable.
2. El motor modifica un artefacto fuera de `product/`, `features/` y
   `.forgium/`.
3. Un comando de verificación comprueba el artefacto y termina con código 0.
4. Los receipts `execution`, `verification` y `review` son válidos y siguen a
   la Feature durante todos sus movimientos.
5. `run` se detiene en `review_required`; únicamente `review` puede llevar a
   `done`.
6. `validate --json` informa validez y `status --json` informa un Inbox
   `promoted` y una Feature `done`.

No se denominará E2E a ninguna prueba que invoque `FilesystemForgiumRepository`,
`runLoop`, `triage` o un adapter directamente.

## Decisión pendiente: verificación declarada desde un Draft

Hoy el editor de Draft no puede declarar `verification`: `DraftSchema` no la
preserva y `promoteDraft` no la copia al manifest. Una Feature sin esa política
avanza a `review` con `not_configured`, así que no demuestra el criterio de
aceptación.

Se propone añadir este campo opcional al frontmatter de Draft y copiarlo,
validado y sin interpretación, al `manifest.yaml` al promover:

```yaml
verification:
  commands:
    - name: target-content
      run: test "$(cat target.txt)" = "after"
```

Es un cambio de contrato público. Antes de implementarlo se actualizarán ADR
0002, ADR 0004, README, tipos y schemas. No se aceptará escribir un manifest
desde Vitest como atajo de fixture.

## Matriz de regresión

### A. Gate offline obligatorio: CLI + motor controlado

Se ejecuta en `npm test` sin red ni modelo. Cada caso lanza `tsx
src/cli/index.ts` mediante `spawn`. Un ejecutable temporal `fake-pi` sustituye
únicamente el proceso externo y emite el RPC documentado; Forgium y sus
adapters siguen siendo los reales.

| ID | Criterio y aserciones |
| --- | --- |
| E2E-CLI-01 | Un usuario completa el flujo directo: `init`, `capture`, `triage --edit`, promoción, `run --engine pi --json`, `review` y `validate` se ejecutan como procesos. El motor escribe `target.txt = after`; la verificación configurada pasa; `run` responde `review_required`; solo después de `review` queda `done`. |
| E2E-CLI-02 | Un motor que reporta `completed` sin cambiar `target.txt` no pasa el criterio: `run` responde `verification_failed`, la Feature queda `doing` y persiste receipts `execution`, `verification: failed` y `handoff`; nunca aparece `done`. |
| E2E-CLI-03 | Un motor ausente conserva la Feature `ready`, no crea lease ni receipts y devuelve `engine_unavailable`. |
| E2E-CLI-04 | En el caso exitoso, `status --json`, `feature list --state done --json` y `validate --json` concuerdan con los receipts: Feature correcta, outcomes correctos, orden lógico y referencias locales seguras. |

La fixture de editor es un ejecutable temporal que recibe `draft.md` y lo
completa. Así se cubre el contrato `$VISUAL`/`$EDITOR` sin que Vitest escriba
estado de Forgium.

### B. Gate de integración real: Pi y pi-spec-flow

Es obligatorio antes de publicar o aceptar cambios que afecten CLI, adapters,
RPC, tickets, receipts o transiciones. Se mantiene opt-in por coste y
credenciales, pero deja de ser un smoke informal.

| ID | Motor | Criterio y aserciones |
| --- | --- | --- |
| E2E-PI-01 | `pi` directo | Recorre la interfaz CLI de E2E-CLI-01 con Pi real, exige `target.txt = after`, verificación configurada, review explícito y validate. |
| E2E-SF-01 | `pi-spec-flow` | Usa `spec.md` y un ticket mínimo, ejecuta `run --engine pi-spec-flow --json`, prueba el efecto observable, `complete: true`, receipts, review CLI y validate. |

Se expondrán `test:e2e:pi:direct`, `test:e2e:pi:spec-flow` y el agregador
`test:e2e:real`. Al fallar se conserva el temporal y el log RPC; al pasar se
limpia salvo `FORGIUM_E2E_KEEP=1`.

### C. Tests de borde y diagnóstico

Se conservan únicamente para invariantes no alcanzables de manera fiable por
E2E: referencias que escapan, colisiones atómicas, parsing RPC y transiciones
inválidas. No son criterio de aceptación ni sustituyen A/B. Se eliminarán los
tests que solo dupliquen el happy path de la matriz A.

## Orden de implementación

1. Aprobar y documentar el contrato `verification` en Draft (ADR 0002/0004).
2. Crear helpers de procesos temporales: CLI, stdin, entorno, timeout y cleanup.
   No importarán el repositorio para realizar acciones.
3. Implementar primero E2E-CLI-01 y E2E-CLI-02 en
   `cli-acceptance-e2e.test.ts`; deben empezar en rojo.
4. Implementar E2E-CLI-03/04 y eliminar duplicaciones de los tests actuales.
5. Borrar `src/core/__tests__/lifecycle-e2e.test.ts` **en el mismo cambio** en
   que E2E-CLI-01 esté verde: nunca se deja una ventana sin cobertura.
6. Reescribir `pi-spec-flow-e2e.test.ts` para usar solo la CLI, añadir la ruta
   directa real y actualizar scripts, Plan 0007, Plan 0001, README y
   CONTRIBUTING.

## Criterios de aceptación del cambio

- [ ] No existe `lifecycle-e2e.test.ts` ni un E2E que use el repositorio para
      simular una sesión de usuario.
- [ ] E2E-CLI-01 a E2E-CLI-04 pasan con `npm test`, sin Pi real, red ni modelo.
- [ ] E2E-CLI-02 prueba que `completed` sin evidencia no llega a `review` ni a
      `done`.
- [ ] E2E-CLI-01 prueba `target.txt = after` mediante el comando que Forgium
      ejecuta y registra, no solo con una aserción posterior de Vitest.
- [ ] E2E-PI-01 y E2E-SF-01 pasan con `npm run test:e2e:real` en un entorno con
      Pi y `pi-spec-flow` instalados.
- [ ] La documentación obliga a ejecutar el gate correcto y mantiene el review
      explícito requerido por ADR 0004.

## Verificación final

```bash
npm test
npm run typecheck
npm run build
git diff --check
npm run test:e2e:real # requerido para release; requiere Pi + pi-spec-flow
```

## Fuera de alcance

- Autoaprobar Features de usuario: contradice ADR 0004.
- Consumir tokens, red o credenciales en `npm test`.
- Simular el texto natural exacto de Pi.
- Convertir cada test de borde en un E2E lento sin flujo observable distinto.
