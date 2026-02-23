// ============================================================================
// MaskLib v0.2 — Cloud & Shadow Masking Library for Google Earth Engine
// ============================================================================
// Sensor:    PlanetScope SuperDove (PSB.SD) — 8 bandas
// Lenguaje:  JavaScript (GEE Code Editor)
// Versión:   0.2.0
// Estado:    Fase 1 completa — Estrategias 1, 2 y 3 implementadas
//
// DESCRIPCIÓN:
//   Librería modular para enmascarar nubes y sombras en imágenes satelitales.
//   Diseñada para reutilización sin reescribir algoritmos desde cero.
//   Compatible con imágenes ordenadas como 'analytic_sr_udm2' (12 bandas en GEE).
//
// USO BÁSICO:
//   var masked = MASKLIB.PS.maskClouds(image);                        // Estrategia automática
//   var masked = MASKLIB.PS.maskByIndices(image, {ndsiThresh: 0.7});  // Solo índices
//   var masked = MASKLIB.PS.maskByUDM2(image, {maskHaze: true});      // Solo UDM2
//   var masked = MASKLIB.PS.maskByClassification(image, {             // Random Forest
//     trainingData: fc, classProperty: 'class', cloudClass: 1
//   });
//
// ESTRUCTURA DE BANDAS — PlanetScope SuperDove (analytic_sr_udm2):
//   Bandas ópticas (reflectancia superficial, escala 0–10000):
//     B1 = Coastal Blue  (431–452 nm)
//     B2 = Blue          (465–515 nm)
//     B3 = Green I       (513–549 nm)
//     B4 = Green         (547–583 nm)
//     B5 = Yellow        (600–620 nm)
//     B6 = Red           (650–680 nm)
//     B7 = Red Edge      (697–713 nm)
//     B8 = NIR           (845–885 nm)
//   Bandas UDM2 (binarias 0/1, excepto Q7 y Q8):
//     Q1 = Clear         (1=claro, 0=no claro)
//     Q2 = Snow          (1=nieve/hielo)
//     Q3 = Cloud Shadow  (1=sombra de nube)
//     Q4 = Haze          (1=neblina — antes Light Haze en UDM2.0)
//     Q5 = Heavy Haze    (siempre 0 en UDM2.1)
//     Q6 = Cloud         (1=nube opaca)
//     Q7 = Confidence    (0–100, confianza del modelo)
//     Q8 = Unusable Mask (bitwise, legado UDM1)
//
// REFERENCIAS:
//   - Planet UDM2.1 Docs: https://developers.planet.com/docs/data/udm-2/
//   - Planet in GEE:      https://developers.planet.com/docs/integrations/gee/gee/
//   - Product Specs:      https://assets.planet.com/docs/Planet_Combined_Imagery_Product_Specs_letter_screen.pdf
// ============================================================================


// ============================================================================
// NAMESPACING — Evita conflictos con variables globales en GEE
// ============================================================================
var MASKLIB = {};
MASKLIB.PS = {};      // PlanetScope SuperDove
MASKLIB.S2 = {};      // Sentinel-2 [PENDIENTE]
MASKLIB.LS = {};      // Landsat 8/9 [PENDIENTE]

// ============================================================================
// ESTRATEGIA 3: ENMASCARAMIENTO POR CLASIFICACIÓN — RANDOM FOREST
// ============================================================================
// Entrena un clasificador Random Forest con muestras de entrenamiento
// provistas por el usuario (FeatureCollections con una propiedad 'class').
//
// El usuario debe proporcionar dos FeatureCollections:
//   - cloudSamples:   puntos/polígonos sobre nubes y/o sombras
//   - clearSamples:   puntos/polígonos sobre píxeles claros (no nube)
// Cada feature debe tener una propiedad categórica con los valores de clase.
//
// CONVENCIÓN DE CLASES (configurable):
//   cloudClass = 1  → nube / sombra (será enmascarado)
//   clearClass = 0  → claro         (será conservado)
//
// FEATURES DE ENTRADA AL CLASIFICADOR:
//   Por defecto usa las 8 bandas ópticas (B1–B8).
//   Opcionalmente agrega índices derivados: NDVI, NDSI, HOT, Whiteness.
//   A más features → más poder discriminativo, pero más tiempo de entrenamiento.
//
// FLUJO:
//   1. Combina cloudSamples + clearSamples en un único FeatureCollection
//   2. Muestrea la imagen en las ubicaciones de entrenamiento
//   3. Entrena el clasificador Random Forest
//   4. Clasifica la imagen completa
//   5. Aplica la máscara: cloudClass → enmascarado, clearClass → conservado
//
// VENTAJAS:
//   - Altamente adaptable a condiciones locales y tipos de nube inusuales
//   - No depende de UDM2 ni de umbrales globales
//   - Puede entrenarse con muestras propias del área de estudio
//   - Produce una capa de probabilidad opcional (softmax)
//
// DESVENTAJAS:
//   - Requiere muestras de entrenamiento (esfuerzo inicial del usuario)
//   - El modelo es específico para la imagen/región de entrenamiento
//   - Puede sobreajustarse si las muestras son pocas o poco representativas
//   - No generaliza automáticamente a otras fechas sin re-entrenamiento
// ============================================================================


/**
 * [ESTRATEGIA 3 — UTILIDAD] Calcula índices espectrales auxiliares para el clasificador RF.
 * Añade NDVI, NDSI, HOT y Whiteness como bandas adicionales a la imagen.
 * Estos índices aumentan el poder discriminativo del Random Forest.
 *
 * @param {ee.Image} image - Imagen PlanetScope SuperDove (B1-B8).
 * @returns {ee.Image} Imagen original + bandas de índices añadidas.
 */
MASKLIB.PS._addSpectralIndicesForRF = function(image) {
  var b = MASKLIB.PS._DEFAULTS.bands;

  // NDVI: Normalized Difference Vegetation Index
  // Vegetación sana → valores altos; nubes → valores bajos o negativos
  var ndvi = image.normalizedDifference([b.nir, b.red]).rename('RF_NDVI');

  // NDSI: Normalized Difference Snow Index — detecta nieve y nubes brillantes
  var ndsi = image.normalizedDifference([b.green, b.nir]).rename('RF_NDSI');

  // HOT: Haze Optimized Transform — neblina y nubes tenues https://doi.org/10.1016/S0034-4257(02)00034-2
  // HOT = Blue - 0.5 * Red
  var hot = image.select(b.blue)
    .subtract(image.select(b.red).multiply(0.5))
    .rename('RF_HOT');

  // Whiteness: cuán espectralmente "blanco" es un píxel (nubes = blancas)
  // Whiteness = desviación media absoluta de Blue, Green, Red respecto a su media
  var mean = image.select([b.blue, b.green, b.red]).reduce(ee.Reducer.mean());
  var whiteness = image.select(b.blue).subtract(mean).abs()
    .add(image.select(b.green).subtract(mean).abs())
    .add(image.select(b.red).subtract(mean).abs())
    .divide(mean.multiply(3))
    .rename('RF_Whiteness');

  // NDWI: Normalized Difference Water Index — agua y sombras vs vegetación
  // Ayuda a discriminar sombras de nubes de cuerpos de agua
  var ndwi = image.normalizedDifference([b.green, b.nir]).rename('RF_NDWI');

  return image.addBands([ndvi, ndsi, hot, whiteness, ndwi]);
};


/**
 * [ESTRATEGIA 3 — UTILIDAD] Prepara y combina las FeatureCollections de entrenamiento.
 * Fusiona cloudSamples y clearSamples en un solo FeatureCollection,
 * asegurando que ambas tengan la propiedad de clase correcta.
 *
 * @param {ee.FeatureCollection} cloudSamples  - Muestras de nubes/sombras.
 * @param {ee.FeatureCollection} clearSamples  - Muestras de píxeles claros.
 * @param {String}               classProperty - Nombre de la propiedad de clase.
 * @param {Number}               cloudClass    - Valor numérico que identifica nubes.
 * @param {Number}               clearClass    - Valor numérico que identifica píxeles claros.
 * @returns {ee.FeatureCollection} FeatureCollection combinado y validado.
 */
MASKLIB.PS._prepareTrainingData = function(cloudSamples, clearSamples, classProperty, cloudClass, clearClass) {
  
  // Normaliza los valores de clase para garantizar consistencia
  // Sobrescribe la propiedad de clase con los valores esperados
  var cloudFC = cloudSamples.map(function(f) {
    return f.set(classProperty, cloudClass);
  });
  
  var clearFC = clearSamples.map(function(f) {
    return f.set(classProperty, clearClass);
  });
  
  // Combina ambas colecciones
  return cloudFC.merge(clearFC);
};


/**
 * [ESTRATEGIA 3 — COMBINADA] Entrena Y aplica el clasificador Random Forest en un solo paso.
 * Función conveniente para cuando se tiene una sola imagen y sus muestras.
 *
 * FLUJO COMPLETO:
 *   cloudSamples + clearSamples → entrenamiento RF → clasificación → máscara aplicada
 *
 * NOTA: Si necesitas clasificar múltiples imágenes con el mismo modelo,
 * usa trainCloudClassifier() y applyClassificationMask() por separado
 * para evitar re-entrenar innecesariamente.
 *
 * @param {ee.Image}             image          - Imagen PlanetScope SuperDove a enmascarar.
 * @param {Object}               params         - Parámetros REQUERIDOS y opcionales:
 *
 *   REQUERIDOS:
 *   @param {ee.FeatureCollection} params.cloudSamples  - Muestras de nubes/sombras.
 *                                                        Cada feature debe tener la propiedad
 *                                                        definida en classProperty con cloudClass.
 *   @param {ee.FeatureCollection} params.clearSamples  - Muestras de píxeles claros.
 *                                                        Cada feature debe tener la propiedad
 *                                                        definida en classProperty con clearClass.
 *
 *   OPCIONALES:
 *   @param {String}  [params.classProperty='class'] - Nombre de la propiedad de clase.
 *   @param {Number}  [params.cloudClass=1]          - Valor numérico de la clase nube/sombra.
 *   @param {Number}  [params.clearClass=0]          - Valor numérico de la clase claro.
 *   @param {Number}  [params.numTrees=100]          - Número de árboles del Random Forest.
 *   @param {Boolean} [params.addIndices=true]       - Agrega índices como features al RF.
 *   @param {Boolean} [params.addClassBand=false]    - Añade banda 'RF_class' al resultado.
 *   @param {Number}  [params.scale=3]               - Escala de muestreo en metros.
 *   @param {Number}  [params.tileScale=2]           - TileScale para operaciones en mosaico.
 *
 * @returns {ee.Image} Imagen con máscara de nubes/sombras aplicada.
 *
 * @example
 * // ─── PREPARACIÓN DE MUESTRAS ───
 * // Las muestras pueden crearse dibujando geometrías en el GEE Code Editor
 * // y convirtiéndolas a FeatureCollection con la propiedad 'class'
 *
 * // Opción A: Puntos dibujados manualmente en el mapa
 * var cloudPoints = ee.FeatureCollection([
 *   ee.Feature(ee.Geometry.Point([-75.123, 4.567]), {'class': 1}),
 *   ee.Feature(ee.Geometry.Point([-75.234, 4.678]), {'class': 1}),
 *   // ... más puntos de nube
 * ]);
 * var clearPoints = ee.FeatureCollection([
 *   ee.Feature(ee.Geometry.Point([-75.345, 4.789]), {'class': 0}),
 *   ee.Feature(ee.Geometry.Point([-75.456, 4.890]), {'class': 0}),
 *   // ... más puntos claros
 * ]);
 *
 * // Opción B: Polígonos desde assets de GEE
 * var cloudPolygons = ee.FeatureCollection('projects/mi-proyecto/assets/cloud_samples');
 * var clearPolygons = ee.FeatureCollection('projects/mi-proyecto/assets/clear_samples');
 *
 * // ─── ENMASCARAMIENTO ───
 * var masked = MASKLIB.PS.maskByClassification(image, {
 *   cloudSamples:  cloudPoints,
 *   clearSamples:  clearPoints,
 *   numTrees:      150,
 *   addIndices:    true,
 *   addClassBand:  true   // Para validar visualmente el resultado
 * });
 *
 * // Visualiza resultado
 * Map.addLayer(masked, {bands:['B6','B4','B2'], min:0, max:3000}, 'RF Masked');
 * Map.addLayer(masked.select('RF_class'), {min:0, max:1, palette:['00AA00','FFFFFF']}, 'Clasificación RF');
 */
MASKLIB.PS.maskByClassification = function(image, params) {
  // Validación de parámetros requeridos
  if (!params || !params.cloudSamples || !params.clearSamples) {
    throw new Error(
      'MaskLib ERROR [maskByClassification]: ' +
      'Se requieren params.cloudSamples y params.clearSamples. ' +
      'Proporciona dos FeatureCollections con la propiedad "' +
      (params && params.classProperty ? params.classProperty : 'class') + '".'
    );
  }

  params = MASKLIB.PS._mergeParams(params, {
    classProperty: 'class',
    cloudClass:    1,
    clearClass:    0,
    numTrees:      100,
    addIndices:    true,
    addClassBand:  false,
    scale:         3,
    tileScale:     2
  });

  // Paso 1: Entrena el clasificador
  var classifier = MASKLIB.PS.trainCloudClassifier(
    image,
    params.cloudSamples,
    params.clearSamples,
    {
      classProperty: params.classProperty,
      cloudClass:    params.cloudClass,
      clearClass:    params.clearClass,
      numTrees:      params.numTrees,
      addIndices:    params.addIndices,
      scale:         params.scale,
      tileScale:     params.tileScale
    }
  );

  // Paso 2: Aplica la clasificación y la máscara
  return MASKLIB.PS.applyClassificationMask(image, classifier, {
    cloudClass:   params.cloudClass,
    addIndices:   params.addIndices,
    addClassBand: params.addClassBand
  });
};


/**
 * [ESTRATEGIA 3 — UTILIDAD] Evalúa la precisión del clasificador Random Forest.
 * Realiza validación cruzada dividiendo las muestras en entrenamiento (70%) y
 * validación (30%), luego calcula la matriz de confusión y métricas de precisión.
 *
 * RECOMENDADO ejecutar antes de usar el clasificador en producción.
 *
 * @param {ee.Image}             image         - Imagen de entrenamiento.
 * @param {ee.FeatureCollection} cloudSamples  - Muestras de nubes/sombras.
 * @param {ee.FeatureCollection} clearSamples  - Muestras de píxeles claros.
 * @param {Object}               [params]      - Mismos parámetros que trainCloudClassifier().
 * @returns {void} Imprime en consola: matriz de confusión, exactitud global y Kappa.
 *
 * @example
 * MASKLIB.PS.evaluateClassifier(image, cloudFC, clearFC, {numTrees: 100});
 */
MASKLIB.PS.evaluateClassifier = function(image, cloudSamples, clearSamples, params) {
  params = MASKLIB.PS._mergeParams(params, {
    classProperty: 'class',
    cloudClass:    1,
    clearClass:    0,
    numTrees:      100,
    addIndices:    true,
    scale:         3,
    tileScale:     2,
    trainFraction: 0.7   // 70% entrenamiento, 30% validación
  });

  // Prepara la imagen con índices si aplica
  var imageForEval = params.addIndices
    ? MASKLIB.PS._addSpectralIndicesForRF(image)
    : image;

  var b = MASKLIB.PS._DEFAULTS.bands;
  var opticalBands  = [b.coastal, b.blue, b.greenI, b.green, b.yellow, b.red, b.redEdge, b.nir];
  var indexBands    = params.addIndices
    ? ['RF_NDVI', 'RF_NDSI', 'RF_HOT', 'RF_Whiteness', 'RF_NDWI']
    : [];
  var inputFeatures = opticalBands.concat(indexBands);

  // Combina y muestrea todas las muestras
  var allSamples = MASKLIB.PS._prepareTrainingData(
    cloudSamples, clearSamples,
    params.classProperty, params.cloudClass, params.clearClass
  );

  var sampledData = imageForEval
    .select(inputFeatures)
    .sampleRegions({
      collection:  allSamples,
      properties:  [params.classProperty],
      scale:       params.scale,
      tileScale:   params.tileScale
    })
    .randomColumn('random', 42);  // Columna aleatoria para dividir train/val

  // División train / validación
  var trainSet = sampledData.filter(ee.Filter.lt('random', params.trainFraction));
  var valSet   = sampledData.filter(ee.Filter.gte('random', params.trainFraction));

  // Entrena con el subset de entrenamiento
  var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees: params.numTrees,
    seed:          42
  })
  .train({
    features:        trainSet,
    classProperty:   params.classProperty,
    inputProperties: inputFeatures
  });

  // Clasifica el subset de validación
  var validated = valSet.classify(classifier);

  // Calcula la matriz de confusión
  var confMatrix = validated.errorMatrix(params.classProperty, 'classification');

  // Imprime resultados en la consola de GEE
  print('─── MaskLib RF — Evaluación del Clasificador ───');
  print('Muestras totales:',      allSamples.size());
  print('Muestras entrenamiento:', trainSet.size());
  print('Muestras validación:',   valSet.size());
  print('Matriz de Confusión:',   confMatrix);
  print('Exactitud Global:',      confMatrix.accuracy());
  print('Índice Kappa:',          confMatrix.kappa());
  print('Exactitud por clase (Producers):', confMatrix.producersAccuracy());
  print('Exactitud por clase (Consumers):', confMatrix.consumersAccuracy());
  print('─────────────────────────────────────────────────');
};
