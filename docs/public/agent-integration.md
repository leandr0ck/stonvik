# Integración de agentes

Un agente externo participa con la misma CLI que un humano o CI. Stonvik no decide qué modelo, skill, framework o proceso editorial debe usar el agente.

Los comandos son exactos y permanecen en inglés (`capture`, `triage`, `define`, `work start`, etc.). Use el binario instalado en el repositorio (`stonvik` o `./node_modules/.bin/stonvik`).

## Protocolo

1. Seleccionar Work definido:

   ```bash
   stonvik --root . --json next
   ```

2. Reclamarlo:

   ```bash
   stonvik --root . work start <work-id> \
     --actor agent:codex \
     --run-id agent-codex-001
   ```

3. Leer el contrato neutral:

   ```bash
   stonvik --root . work handoff <work-id> --format json > handoff.json
   ```

4. Leer las referencias `definitions` si el Work tiene spec o ADR. Esos archivos pertenecen al equipo y su formato es libre.

Para enlazar una Spec solicitada por el usuario con un item de Inbox, el agente debe leer el item, comprobar que la ruta de la Spec existe, ejecutar `triage --route spec` si aún no tiene routing y luego ejecutar `define --spec` con objetivo, aceptación y verificación. Si faltan esos campos, debe pedirlos; no debe inventarlos. Si el item ya es Work, no debe editar `manifest.yaml`: el CLI actual no soporta enlazar definiciones a Work existente.

5. Implementar con el proceso propio del agente. No modificar manifests, receipts, claims, `product/` ni `features/` para cambiar el workflow.

6. Crear un reporte JSON y registrarlo:

   ```bash
   stonvik --root . work report <work-id> --receipt result.json
   ```

7. Verificar y solicitar review a otro actor:

   ```bash
   stonvik --root . verify <work-id>
   stonvik --root . work review <work-id> \
     --actor human:reviewer \
     --decision approved \
     --summary "Revisado contra el manifest."
   stonvik --root . ship <work-id>
   ```

Un review aprobado no es todavía `done`; `ship` es el gate final. Un implementador nunca aprueba su propia ejecución.

## Reportes honestos

El reporte mínimo es:

```json
{
  "schemaVersion": 1,
  "actor": { "type": "agent", "name": "codex", "role": "implementer" },
  "outcome": "completed",
  "summary": "Resultado verificable y conciso."
}
```

`outcome` también puede ser `blocked`, `needs_human` o `cancelled`. Añada `artifacts` solo para paths existentes y `evidence` para evidencia localizable o URLs. `completed` no equivale a verificación ni aprobación.

## Recuperación

Si el agente desaparece, inspeccione primero el claim:

```bash
stonvik --root . work claim <work-id>
```

Use `work recover` solo después de confirmar que el proceso anterior ya no existe. No borre claims manualmente.

## Límites de confianza

`--actor` y `STONVIK_ACTOR` registran procedencia declarada; no son autenticación. Los gates se basan en contratos, receipts y transiciones persistidas en el repositorio.
