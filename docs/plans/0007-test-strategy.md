# Plan 0007: Estrategia de pruebas end-to-end y endurecimiento

**Estado:** Completado para el alcance inicial
**Fecha:** 2026-07-12  
**Actualizado:** 2026-07-13
**Aplica a:** Fase 6 de [Plan 0001](0001-loop-implementation-plan.md)

## Casos

- Recorrido completo `Inbox → Draft → ready → doing → review → done` con un
  adapter determinista.
- Inicialización y CLI en repositorios sin Git y con Git.
- Features creadas por la CLI existente siguen siendo compatibles con el
  adapter y las transiciones actuales.
- Colisiones de slug, Drafts inválidos y receipts con referencias rotas no
  producen estados parciales.
- La ayuda de CLI expone los comandos definitivos `triage`, `run` y
  `feature verify`.
- Smoke test opt-in con Pi real y `pi-spec-flow@0.4.8`: edita un archivo de
  texto de una sola línea, completa el ticket, devuelve `complete: true`,
  persiste receipts y requiere una aprobación explícita para llegar a `done`.

El smoke test no se ejecuta en `npm test`, ya que utiliza el modelo configurado
en Pi y puede incurrir en coste. Para ejecutarlo explícitamente:

```bash
npm run test:e2e:pi
```

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```
