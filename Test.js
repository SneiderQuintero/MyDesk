
// ============================================================
//  ENMASCARAMIENTO POR CLASIFICACIÓN — Random Forest
//  PlanetScope SuperDove · 8 Bandas · 3 Clases
//  nube=1 · sombra=2 · limpio=3
//
//  - Firmas espectrales: imagen 2025-01-19_strip_7805331_composite
//  - Muestras: geometry dibujada manualmente en GEE
//  - Aplicación: toda la colección aecomdique
// ============================================================

// -----------------------------------------------------------
// 0. PARÁMETROS
// -----------------------------------------------------------
var ASSET_ID    = 'projects/ee-sneiderquintero/assets/aecomdique';
var IMAGEN_ID   = 'projects/ee-sneiderquintero/assets/aecomdique/2025-01-19_strip_7805331_composite';
var CAMPO_CLASE = 'class';   // nube=1, tierra=2, agua=3
var N_ARBOLES   = 350;
var BANDAS      = ['b1','b2','b3','b4','b5','b6','b7','b8'];

// -----------------------------------------------------------
// 1. INSTRUCCIONES PARA DIBUJAR LAS MUESTRAS
// -----------------------------------------------------------
// Antes de correr este script debes:
//
//  1. En el panel izquierdo de GEE → "Geometry Imports" → "+ new layer"
//  2. Crear UNA capa por clase, con estos nombres y propiedades:
//
//     Capa 1 → Renombrar a "nube"
//              Geometry type: Polygon
//              En "Configure geometry import" → agregar propiedad:
//              class = 1
//
//     Capa 2 → Renombrar a "sombra"
//              class = 2
//
//     Capa 3 → Renombrar a "limpio"
//              class = 3
//
//  3. Dibujar polígonos sobre la imagen de referencia activada abajo
//     Mínimo recomendado: 5–10 polígonos por clase
//
//  4. Correr el script → las 3 capas se fusionan automáticamente

// -----------------------------------------------------------
// 2. FUSIONAR LAS 3 GEOMETRÍAS EN UNA SOLA COLECCIÓN
//    GEE las importa automáticamente como variables globales
//    con el nombre que les pusiste en el paso anterior
// -----------------------------------------------------------

// -----------------------------------------------------------
// 3. IMAGEN DE ENTRENAMIENTO
//    Las firmas espectrales se extraen SOLO de esta imagen
// -----------------------------------------------------------
var imagenEntrenamiento = ee.Image(IMAGEN_ID).select(BANDAS);

print('Imagen de entrenamiento:', imagenEntrenamiento.id());

// Visualizar para poder dibujar polígonos sobre ella
var visRGB = {bands: ['b6','b4','b2'], min: 0, max: 1500, gamma: 1.4};
var visCIR = {bands: ['b8','b6','b4'], min: 0, max: 2000, gamma: 1.4};

Map.centerObject(imagenEntrenamiento, 12);
Map.addLayer(imagenEntrenamiento, visRGB, '🖊️ Imagen de entrenamiento — RGB (dibuja aquí)', true);
Map.addLayer(imagenEntrenamiento, visCIR, '🖊️ Imagen de entrenamiento — CIR', false);

// -----------------------------------------------------------
// 4. EXTRAER PUNTOS DE ENTRENAMIENTO
// -----------------------------------------------------------
// ── 1. Extraer puntos POR CLASE ──────────────────────────────
var muestrasPorClase = [nubes, tierra, agua];  // misma clase que CLASES = [1, 2, 3]

var entrenamiento = [];
var validacion    = [];

for (var i = 0; i < muestrasPorClase.length; i++) {

  var puntos = imagenEntrenamiento.sampleRegions({
    collection : muestrasPorClase[i],
    properties : [CAMPO_CLASE],
    scale      : 3,
    geometries : true,
    tileScale  : 1
  })
  .randomColumn('random', SEMILLA)
  .sort('random');

  print('Puntos extraídos clase ' + CLASES[i] + ':', puntos.size());

  entrenamiento.push(puntos.filter(ee.Filter.lte('random', 0.7)));
  validacion.push(   puntos.filter(ee.Filter.gt( 'random', 0.7)));
}

entrenamiento = ee.FeatureCollection(entrenamiento).flatten();
validacion    = ee.FeatureCollection(validacion).flatten();

print('── ENTRENAMIENTO ──');
print('Total:', entrenamiento.size());
print('Por clase:', entrenamiento.aggregate_histogram(CAMPO_CLASE));

print('── VALIDACIÓN ──');
print('Total:', validacion.size());
print('Por clase:', validacion.aggregate_histogram(CAMPO_CLASE));
// -----------------------------------------------------------
// 5. ENTRENAR RANDOM FOREST
// -----------------------------------------------------------
var clasificador = ee.Classifier.smileRandomForest({
  numberOfTrees : N_ARBOLES,
  seed          : 42
}).train({
  features       : entrenamiento,
  classProperty  : CAMPO_CLASE,
  inputProperties: BANDAS
});

// Importancia de bandas
var importancia = ee.Dictionary(clasificador.explain().get('importance'));
print('📊 Importancia de bandas:', importancia);

var chartImportancia = ui.Chart.feature.byProperty({
  features    : ee.Feature(null, importancia),
  xProperties : BANDAS
}).setChartType('ColumnChart')
  .setOptions({
    title : 'Importancia de bandas — Random Forest',
    hAxis : {title: 'Banda'},
    vAxis : {title: 'Importancia'},
    colors: ['#3b82f6']
  });
print(chartImportancia);

// -----------------------------------------------------------
// 6. VALIDACIÓN
// -----------------------------------------------------------
var validacionClasificada = validacion.classify(clasificador);
var matriz = validacionClasificada.errorMatrix(CAMPO_CLASE, 'classification');

print('─────────────────────────────────────────────');
print('✅ MATRIZ DE CONFUSIÓN');
print('   Filas=real · Columnas=predicho');
print('   1=nube  2=sombra  3=limpio');
print(matriz);
print('Overall Accuracy :', matriz.accuracy());
print('Kappa            :', matriz.kappa());
print('Producers Acc    :', matriz.producersAccuracy());
print('Consumers Acc    :', matriz.consumersAccuracy());
print('─────────────────────────────────────────────');

// -----------------------------------------------------------
// 7. CLASIFICAR Y ENMASCARAR TODA LA COLECCIÓN
// -----------------------------------------------------------
var coleccion = ee.ImageCollection(ASSET_ID);

function clasificarYEnmascarar(imagen) {
  var clasificacion = imagen.select(BANDAS).classify(clasificador);
  // Solo clase 3 (limpio) pasa la máscara
  return imagen.updateMask(clasificacion.eq(3));
}

var coleccionEnmascarada = coleccion.map(clasificarYEnmascarar);

// Composite mediana
var compositeMediana = coleccionEnmascarada.median();

// -----------------------------------------------------------
// 8. CLASIFICACIÓN DE LA IMAGEN DE ENTRENAMIENTO (inspección)
// -----------------------------------------------------------
var clasificacionRef = imagenEntrenamiento.classify(clasificador);

var visClase = {
  min    : 1, max: 3,
  palette: ['#ffffff',   // 1 = nube   → blanco
            '#444444',   // 2 = sombra → gris
            '#22c55e']   // 3 = limpio → verde
};

Map.addLayer(clasificacionRef,              visClase, '🎨 Clasificación RF — imagen entrenamiento', false);
Map.addLayer(coleccionEnmascarada.first(),  visRGB,   '✅ Primera imagen enmascarada', false);
Map.addLayer(compositeMediana,              visRGB,   '✅ Mediana Enmascarada — RGB', false);
Map.addLayer(compositeMediana,              visCIR,   '✅ Mediana Enmascarada — CIR', false);
