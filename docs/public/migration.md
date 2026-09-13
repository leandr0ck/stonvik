# Migración desde el workflow anterior

El rediseño es incremental. El estado histórico se conserva y las rutas antiguas siguen disponibles durante la ventana de compatibilidad.

## Mapeo de comandos

| Antes | Ruta recomendada |
| --- | --- |
| `stonvik triage` | `capture` + `prepare` + decisión humana cuando sea necesaria |
| `stonvik implement` | `work start` + `handoff` + ejecución externa + `work report` |
| `stonvik run` | Loop externo que consulte `next` y use el protocolo de reportes |
| `stonvik work-review` | `work review` con actor y decisión explícitos |
| Adapter Pi dentro de servicios | Proceso externo que consume handoff y reporta por CLI |

`run`, `triage` e `implement --engine pi-spec-flow` muestran una ruta de compatibilidad; no son la interfaz recomendada para nuevas integraciones.

## Estado histórico

- Un manifest sin `kind` se lee como `implementation`.
- Los receipts Pi existentes siguen siendo receipts de ejecución válidos.
- `engine` se conserva como metadata histórica; los nuevos receipts pueden incluir `actor`.
- No se reescriben ni borran receipts históricos.
- `stonvik migrate inbox-provenance` mueve provenance histórica incompleta al Work correspondiente sin eliminar evidencia.

## Configuración

La configuración histórica con `pi`, `classification`, `execution` y `review` sigue siendo válida para las rutas Pi de compatibilidad. El core neutral solo consume la sección `routing`.

Ejemplo de configuración nueva:

```json
{
  "routing": {
    "direct": {
      "maximumSize": "S",
      "maximumTouchedFiles": 3
    }
  }
}
```

No es necesario instalar Pi para usar `capture`, `prepare`, `next`, `handoff`, `work`, `verify`, `validate` y el ciclo manual completo.

## Plan de adopción

1. Instalar Stonvik en el repositorio y ejecutar `init`.
2. Ejecutar `validate` antes de migrar actores.
3. Probar un Work pequeño con el flujo neutral.
4. Mover agentes y CI a la Skill y a los contratos externos.
5. Mantener las rutas antiguas solo para Work histórico o compatibilidad.
6. Retirar las rutas Pi en una versión mayor, con una decisión de migración separada.
