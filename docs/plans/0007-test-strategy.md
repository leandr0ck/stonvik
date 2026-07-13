# Plan 0007: Estrategia de pruebas end-to-end y endurecimiento

**Estado:** Activo  
**Fecha:** 2026-07-12  
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

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

