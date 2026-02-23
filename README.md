Correcciones de Imágenes Satelitales – v1.0

Este repositorio contiene la primera versión de un conjunto de scripts orientados al preprocesamiento y corrección de imágenes satelitales, con el objetivo de mejorar su calidad radiométrica y facilitar su análisis posterior en estudios de teledetección.

📌 Descripción general

El código implementa una serie de correcciones básicas aplicadas a imágenes satelitales ópticas, enfocadas en reducir interferencias atmosféricas y geométricas, así como en mejorar la discriminación de coberturas terrestres y acuáticas.

Esta versión corresponde a una fase inicial del desarrollo, por lo que las funcionalidades pueden ampliarse, optimizarse o modificarse en futuras versiones.

🛰️ Correcciones implementadas

En esta primera versión se contemplan los siguientes procesos:

Enmascaramiento de nubes y sombras

Separación tierra–agua mediante clasificación supervisada

Corrección por brillo solar (sun glint)

Cálculo del índice de profundidad invariante

Preparación de imágenes para análisis espectral y temático

🧪 Alcance de la versión actual

Procesamiento básico de imágenes satelitales ópticas

Enfoque en entornos costeros y acuáticos

Scripts orientados a pruebas y validación metodológica

⚠️ Esta versión no está optimizada para grandes volúmenes de datos ni procesamiento en tiempo real.

📁 Estructura del repositorio
├── data/               # Imágenes de entrada (no incluidas en el repositorio)
├── scripts/            # Scripts de corrección y procesamiento
├── outputs/            # Resultados generados
├── docs/               # Documentación adicional
└── README.md           # Documentación principal
⚙️ Requisitos

Dependiendo de la implementación, el proyecto puede requerir:

Python 3.x

Librerías comunes de teledetección y análisis geoespacial (ej. NumPy, GDAL, Rasterio, etc.)

Entorno local o plataforma de procesamiento compatible

Los requisitos específicos se detallarán en futuras versiones.

🚀 Uso básico

Clonar el repositorio:

git clone https://github.com/usuario/nombre-del-repositorio.git

Configurar las rutas de las imágenes de entrada

Ejecutar los scripts de corrección según el flujo definido

🔄 Próximas mejoras

Optimización del flujo de procesamiento

Automatización de etapas

Soporte para múltiples sensores

Integración con plataformas en la nube

Validación cuantitativa de resultados

📄 Estado del proyecto

🧩 Versión: 1.0
🛠️ Estado: En desarrollo
📅 Fase: Prototipo inicial

✍️ Autor

Desarrollado por Sneider Quintero
Proyecto enfocado en análisis y procesamiento de imágenes satelitales.
