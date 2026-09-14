# Seguridad y modelo de confianza

Stonvik protege la integridad del workflow local; no intenta convertir una identidad declarada en autenticación.

## Identidad

`--actor human:lean`, `--actor agent:codex` y `--actor ci:github` son declaraciones de procedencia. Un usuario con permisos de escritura en el repositorio puede falsificarlas. Para autenticación fuerte o receipts firmados se necesita una capa posterior.

Stonvik sí usa esas identidades para prevenir errores accidentales:

- un reporte debe coincidir con el claim activo;
- el reviewer no puede ser el mismo actor que ejecutó el Work;
- los roles permiten registrar quién tomó una decisión de routing;
- un claim stale requiere recuperación explícita.

## Estado protegido

Los actores externos no deben modificar directamente:

- `product/inbox/` para avanzar intención;
- `features/ready`, `doing`, `review`, `blocked` o `done` para cambiar estado;
- manifests, receipts, claims o event streams.

Usar siempre la CLI. Las transiciones mueven el directorio completo del Work y los receipts se escriben de forma append-only.

## Paths de reportes

Los artifacts externos se validan como paths existentes dentro del repositorio y no simbólicos. Se rechazan rutas absolutas y segmentos `..`. Los reportes se leen desde paths relativos al repositorio mediante la CLI.

Esta validación evita que un reporte convierta un path arbitrario en evidencia durable o en una referencia de otro árbol de archivos.

## Resultados no confiables

Un actor puede declarar `completed` de forma incorrecta. Por eso el protocolo separa:

1. execution receipt: declaración del actor;
2. verification receipt: checks deterministas ejecutados por Stonvik;
3. review receipt: decisión semántica de otro actor.

Ninguno de los tres debe interpretarse como autenticación del actor.

## Claims y concurrencia

Los claims viven en `.stonvik/runtime/` y no se comparten como estado durable. Protegen contra dos actores locales reclamando el mismo Work por accidente, pero no sustituyen un coordinador distribuido.

Un pipeline debe evitar verificar o revisar el mismo Work en paralelo con otro pipeline.

## Secretos

No incluir credenciales en `summary`, `details`, nombres de actor o rationale. Los comandos de verificación se ejecutan desde la raíz del repositorio; solo deben provenir de manifests y especificaciones confiables y revisadas.
