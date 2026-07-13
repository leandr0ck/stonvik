# Plan 0003: Estrategia de pruebas para triage

**Estado:** Activo  
**Fecha:** 2026-07-12  
**Aplica a:** Fase 2 de [Plan 0001](0001-loop-implementation-plan.md) y
[ADR 0003](../adr/0003-forgium-run-contract.md)

## Objetivo

Verificar que `forgium triage` compone las primitivas de Draft e Inbox sin
aprobar intención cruda accidentalmente, sin escribir en `--dry-run` y dejando
un flujo CLI retomable.

## Casos TDD

- **Rojo:** el modo no interactivo no modifica Inbox `captured` y promueve
  únicamente Drafts ya válidos.
- **Rojo:** el modo interactivo permite aprobar un Inbox, diferirlo, mezclarlo
  con una Feature o saltarlo.
- **Rojo:** `--dry-run` no crea Drafts, no mueve directorios y devuelve la
  siguiente acción.
- **Rojo:** el flujo CLI `capture → triage approve → triage promote` deja
  `Inbox promoted`, `draftRef`, `featureRef` y una Feature `ready` válida.
- **Rojo:** un editor configurado se ejecuta sin shell y la ausencia de
  `$VISUAL`/`$EDITOR` produce un error explícito.

## Verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

