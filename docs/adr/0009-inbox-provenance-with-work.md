# ADR 0009: Procedencia de Inbox junto a Work

**Estado:** Aceptado  
**Fecha:** 2026-07-14  
**Decisores:** Forgium maintainers

## Contexto

El Inbox es una entrada de intención cruda, no una cola ejecutable ni un
histórico de Work. Mantener en `product/inbox/` elementos `promoted` o
`merged` duplica el expediente de una Work y obliga a buscar su procedencia y
sus receipts de clasificación fuera del directorio que llega a `done`.

ADR 0004 ya establece que los receipts de ejecución, verificación y review
viajan con el directorio completo de la Work. La evidencia de clasificación y
la solicitud original deben tener la misma propiedad de localidad.

## Decisión

Al asociar un Inbox a una Work, Forgium **mueve** —nunca copia ni elimina— el
Markdown original y todos sus receipts de clasificación al directorio de esa
Work:

```text
features/<state>/<slug>/
├── manifest.yaml
├── provenance/
│   ├── inbox/
│   │   └── <archivo-original>.md
│   └── classification/
│       └── <inbox-id>-<run-id>.yaml
└── receipts/
```

El archivo de procedencia conserva su ID, contenido y estado terminal
`promoted` o `merged`, más `featureRef`. `manifest.source.ref` continúa usando
el ID de Inbox, por lo que ningún enlace durable depende de su ruta anterior.
Como las transiciones de Work mueven el directorio completo, la procedencia
acaba con la Work en `features/done/`.

`product/inbox/` y `product/inbox-receipts/` contienen únicamente elementos
aún no asociados a una Work. Los elementos `deferred` y `rejected` permanecen
en el Inbox hasta que una decisión posterior defina su archivo de cierre,
porque no tienen una Work a la que pertenecer.

## Integridad y migración

- La asociación valida que no colisionen los destinos y revierte los movimientos
  ya hechos si falla la operación.
- `forgium validate` comprueba que cada Inbox de procedencia esté asociado a
  la Work que lo contiene y que cada receipt de clasificación corresponda a un
  Inbox adjunto.
- `forgium migrate inbox-provenance` mueve los elementos históricos
  `promoted` y `merged` cuando su `featureRef` puede resolverse. Los vínculos
  rotos no se eliminan: se informan como omitidos para intervención humana.

## Consecuencias

- `features/done/` contiene el expediente auditable completo de una Work:
  intención, clasificación, contrato, ejecución, verificación y review.
- El Inbox vuelve a representar trabajo pendiente de clasificación o
  definición.
- La sección 3 de ADR 0002 queda reemplazada en lo referente a conservar los
  Inbox promovidos o merged en `product/inbox/`. La auditoría se preserva por
  reubicación, no por duplicación.
