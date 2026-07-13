# Plan 0002: Estrategia de pruebas para Drafts

**Estado:** Activo  
**Fecha:** 2026-07-12  
**Aplica a:** Fase 1 de [Plan 0001](0001-loop-implementation-plan.md) y
[ADR 0002](../adr/0002-draft-state-and-artifacts.md)

## Objetivo

Probar primero las garantías deterministas del ciclo Inbox → Draft → Feature
`ready`, sin invocar agentes ni depender de Git. Los tests usan repositorios
temporales y observan tanto los artefactos persistidos como las referencias de
procedencia.

## Orden TDD

1. **Rojo:** especificar el contrato público de Drafts con tests de repositorio
   y esquema. Los tests deben fallar porque aún no existen los tipos, APIs ni
   el directorio `features/draft/`.
2. **Verde:** implementar el modelo, el esquema, la persistencia atómica, las
   APIs y los contadores de estado/validación mínimos.
3. **Refactor:** mantener `FeatureState` sin el estado `draft`, reutilizar las
   primitivas de lectura/escritura existentes y eliminar duplicación solo si no
   cambia el contrato probado.

## Matriz de comportamiento

| Caso | Garantía |
| --- | --- |
| Inicialización | `features/draft/` existe y un Draft no aparece como Feature `ready`. |
| Creación desde Inbox | El Draft conserva título, cuerpo y `source.ref`; el Inbox pasa a `drafted` con `draftRef`. |
| Esquema | `DraftSchema` acepta `goal` y `acceptance` vacíos, pero exige identidad, fecha, fuente y título. |
| Promoción inválida | Un Draft sin objetivo o criterios no se mueve y no genera `manifest.yaml`. |
| Promoción válida | Se genera un manifest válido, se mueve el directorio completo a `ready` y el Inbox queda `promoted` con `draftRef` y `featureRef`. |
| Colisiones | No se sobrescribe un Draft ni una Feature existente. |
| Validación/status | Los Drafts inválidos aparecen en `validate`; `status` los cuenta sin tratarlos como Features ejecutables. |

## Aislamiento y fallos

- Cada test crea un directorio temporal; no usa el repositorio de trabajo.
- Las escrituras de `draft.md`, `manifest.yaml` y frontmatter del Inbox se
  validan antes de persistirse y usan el helper atómico del repositorio.
- Las pruebas de promoción verifican que no exista una Feature parcial cuando
  la validación del Draft falla. Los tests de rollback de errores de I/O se
  añadirán cuando el repositorio exponga una inyección de almacenamiento sin
  acoplar el dominio al sistema de archivos.

## Comandos de verificación

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

