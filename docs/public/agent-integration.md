# Integración de agentes

Un agente externo no necesita un adapter privilegiado ni acceso a APIs internas. Puede participar usando la misma CLI que un humano o CI.

## Protocolo

1. Seleccionar el Work:

   ```bash
   stonvik --root . --json next
   ```

2. Reclamarlo con una identidad declarada:

   ```bash
   stonvik --root . work start <work-id> \
     --actor agent:codex \
     --run-id agent-codex-001
   ```

3. Leer el contexto neutral:

   ```bash
   stonvik --root . handoff <work-id> --format json > handoff.json
   ```

4. Modificar los archivos de producto necesarios. El agente no debe modificar manifests, receipts, claims, leases, `product/` ni `features/` para cambiar el workflow.

5. Escribir un `ExternalExecutionReport` y entregarlo mediante:

   ```bash
   stonvik --root . work report <work-id> --receipt result.json
   ```

6. Ejecutar o solicitar verificación:

   ```bash
   stonvik --root . verify <work-id>
   ```

7. Dejar el review a un actor diferente. Un implementador nunca debe aprobar su propia ejecución.

## Resultados honestos

Usar `completed` solo cuando el actor terminó su trabajo y puede describirlo. Usar:

- `blocked` cuando una dependencia impide continuar;
- `needs_human` cuando hace falta una decisión o información humana;
- `cancelled` cuando la ejecución se detuvo antes de terminar.

No convertir un error de herramienta o una salida ambigua en `completed` para avanzar el pipeline.

## Recuperación

Si el agente desaparece, el siguiente actor debe inspeccionar primero:

```bash
stonvik --root . work claim <work-id>
```

Solo debe ejecutar `work recover` después de confirmar que el proceso reclamante ya no existe. No borrar ni reescribir claims manualmente.

## Uso de la Skill

El paquete incluye `skills/stonvik-workflow/SKILL.md`. Es una capa de instrucciones para agentes que sepan cargar Agent Skills. La Skill enseña el protocolo, pero no reemplaza la CLI ni los schemas.

Instalarla en el directorio de skills que utilice el runtime del cliente y mantener la misma versión que el paquete de Stonvik. En entornos que versionan skills dentro del repositorio, se puede copiar como una skill local; en entornos globales, instalarla en el catálogo de skills del agente.

La Skill no contiene configuración de Pi, nombres de modelos ni lógica de persistencia.

## Contrato de salida

El agente debe producir al menos:

```json
{
  "schemaVersion": 1,
  "actor": { "type": "agent", "name": "codex", "role": "implementer" },
  "outcome": "completed",
  "summary": "Resultado verificable y conciso."
}
```

Añadir `artifacts` solo para paths que existan en el repositorio. Añadir `evidence` cuando exista una evidencia concreta que Stonvik o CI pueda localizar.
