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
// CONFIGURACIÓN POR DEFECTO — PlanetScope SuperDove
// ============================================================================
MASKLIB.PS._DEFAULTS = {

  // --- Nombres de bandas ópticas ---
  bands: {
    coastal:   'B1',
    blue:      'B2',
    greenI:    'B3',
    green:     'B4',
    yellow:    'B5',
    red:       'B6',
    redEdge:   'B7',
    nir:       'B8'
  },

  // --- Nombres de bandas UDM2 ---
  udm2: {
    clear:      'Q1',
    snow:       'Q2',
    shadow:     'Q3',
    haze:       'Q4',
    heavyHaze:  'Q5',  // Siempre 0 en UDM2.1
    cloud:      'Q6',
    confidence: 'Q7',
    unusable:   'Q8'
  },

  // --- Umbrales para enmascaramiento por índices (Estrategia 1) ---
  // Ajustables por el usuario al llamar las funciones
  thresholds: {
    // NDSI: Normalized Difference Snow Index — detecta nieve y hielos brillantes
    // Fórmula: (Green - NIR) / (Green + NIR)
    // Nubes muy brillantes también pueden superar este umbral
    ndsiCloud:     0.8,   // Umbral alto → solo nubes muy brillantes
    ndsiSnow:      0.4,   // Umbral medio → nieve + nubes moderadas

    // Whiteness: mide cuán "blanco" es un píxel (nubes = muy blancas)
    // Fórmula: suma de desviaciones absolutas de cada banda respecto al promedio
    // Valores altos = píxel blanco = probable nube
    whiteness:     0.7,

    // HOT (Haze Optimized Transform): detecta neblina y nubes tenues
    // Fórmula: Blue - 0.5 * Red - 0.08
    // Valores positivos indican presencia de neblina/nube
    hot:           0.08,

    // Reflectancia mínima de Blue para considerar una nube
    // Las nubes tienen alta reflectancia en el azul (SR típico > 0.2 = 2000 en escala 0-10000)
    blueMin:       2000,

    // Diferencia NIR-Red para detectar sombras
    // Las sombras tienen baja reflectancia general, especialmente en NIR
    shadowNirMax:  1500,  // NIR < 1500 en escala 0-10000 → posible sombra
    shadowBlueMax: 600,   // Blue < 600 → región oscura (sombra)

    // Confianza mínima del modelo UDM2 para aplicar la máscara (Estrategia 2)
    // 0 = acepta todas las clasificaciones sin importar confianza
    // 50 = solo aplica si el modelo tiene ≥50% de confianza
    udm2Confidence: 0
  }
};


// ============================================================================
// UTILIDADES INTERNAS
// ============================================================================

/**
 * Combina parámetros del usuario con los valores por defecto.
 * @param {Object} userParams - Parámetros proporcionados por el usuario.
 * @param {Object} defaults   - Valores por defecto de la librería.
 * @returns {Object} Objeto combinado.
 */
MASKLIB.PS._mergeParams = function(userParams, defaults) {
  userParams = userParams || {};
  var merged = {};
  // Copia todos los defaults
  for (var key in defaults) {
    if (defaults.hasOwnProperty(key)) {
      merged[key] = defaults[key];
    }
  }
  // Sobreescribe con valores del usuario
  for (var key in userParams) {
    if (userParams.hasOwnProperty(key)) {
      merged[key] = userParams[key];
    }
  }
  return merged;
};

/**
 * Valida que una imagen tenga las bandas UDM2 necesarias.
 * Las imágenes deben ser ordenadas como 'analytic_sr_udm2' para tener Q1-Q8.
 * @param {ee.Image} image - Imagen a validar.
 * @returns {Boolean} True si tiene bandas UDM2.
 */
MASKLIB.PS._hasUDM2 = function(image) {
  var bandNames = image.bandNames();
  var hasQ1 = bandNames.contains('Q1');
  var hasQ6 = bandNames.contains('Q6');
  return ee.Algorithms.If(
    hasQ1.and(hasQ6),
    true,
    false
  );
};


// ============================================================================
// ESTRATEGIA 1: ENMASCARAMIENTO POR ÍNDICES ESPECTRALES Y VALORES DE BANDAS
// ============================================================================
// Basado en propiedades físicas de las nubes y sombras:
//   - Nubes: alta reflectancia en visible, especialmente azul; apariencia "blanca"
//   - Sombras: baja reflectancia general, especialmente NIR y Blue
//
// VENTAJAS:  No requiere UDM2; funciona con imágenes 'analytic_sr' (sin UDM2)
// DESVENTAJAS: Umbrales pueden necesitar ajuste según región geográfica y época
//
// NOTA IMPORTANTE:
//   PlanetScope NO tiene bandas SWIR ni Térmicas, lo que limita algunos
//   algoritmos clásicos (Fmask, ACCA). Los índices implementados aquí son
//   adaptaciones probadas para sensores con solo bandas VNIR.
// ============================================================================

/**
 * [ESTRATEGIA 1] Enmascara nubes usando el índice NDSI adaptado.
 * El NDSI (Normalized Difference Snow Index) detecta superficies brillantes
 * como nieve y nubes densas que tienen alta reflectancia en Green y baja en NIR.
 * 
 * @param {ee.Image} image     - Imagen PlanetScope SuperDove (reflectancia superficial).
 * @param {Object}   [params]  - Parámetros opcionales:
 *   @param {Number} [params.threshold=0.8] - Umbral NDSI. Píxeles > threshold son enmascarados.
 *                                            Rango sugerido: 0.6-0.9 para nubes densas.
 * @returns {ee.Image} Imagen con máscara de nubes aplicada (nubes = 0).
 *
 * @example
 * var masked = MASKLIB.PS.maskByNDSI(image, {threshold: 0.75});
 */
MASKLIB.PS.maskByNDSI = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {threshold: MASKLIB.PS._DEFAULTS.thresholds.ndsiCloud});
  var b = MASKLIB.PS._DEFAULTS.bands;
  
  // NDSI = (Green - NIR) / (Green + NIR)
  var ndsi = image.normalizedDifference([b.green, b.nir]).rename('NDSI');
  
  // Píxeles con NDSI > umbral → probable nube o nieve → enmascarar (valor 0)
  var cloudMask = ndsi.lt(params.threshold);
  
  return image.updateMask(cloudMask)
    .set('masklib_ndsi_threshold', params.threshold)
    .set('masklib_strategy', 'indices_ndsi');
};


/**
 * [ESTRATEGIA 1] Enmascara nubes usando el índice de "Blancura" (Whiteness).
 * Las nubes son espectralmente blancas: su reflectancia es similar en todas
 * las bandas del visible. Mide la desviación de cada banda respecto al promedio.
 *
 * Algoritmo adaptado de Zhu & Woodcock (2012) para sensores sin SWIR.
 * Usa las bandas Blue, Green, Red (más representativas del visible en SuperDove).
 *
 * @param {ee.Image} image     - Imagen PlanetScope SuperDove.
 * @param {Object}   [params]  - Parámetros opcionales:
 *   @param {Number} [params.threshold=0.7] - Umbral de blancura (0-1). 
 *                                            Valores más altos → menos estricto.
 * @returns {ee.Image} Imagen enmascarada.
 *
 * @example
 * var masked = MASKLIB.PS.maskByWhiteness(image, {threshold: 0.6});
 */
MASKLIB.PS.maskByWhiteness = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {threshold: MASKLIB.PS._DEFAULTS.thresholds.whiteness});
  var b = MASKLIB.PS._DEFAULTS.bands;
  
  // Promedio de bandas visible (Blue, Green, Red)
  var mean = image.select([b.blue, b.green, b.red]).reduce(ee.Reducer.mean());
  
  // Whiteness = promedio de desviaciones absolutas / media
  // Valores cerca de 0 = muy blanco (espectro plano) = probable nube
  var blueDeviation  = image.select(b.blue).subtract(mean).abs().divide(mean);
  var greenDeviation = image.select(b.green).subtract(mean).abs().divide(mean);
  var redDeviation   = image.select(b.red).subtract(mean).abs().divide(mean);
  
  var whiteness = blueDeviation.add(greenDeviation).add(redDeviation)
    .divide(3)
    .rename('Whiteness');
  
  // Píxeles "blancos" (whiteness < threshold) con alta reflectancia en blue → nube
  var highBlue = image.select(b.blue).gt(MASKLIB.PS._DEFAULTS.thresholds.blueMin);
  var cloudMask = whiteness.gt(params.threshold).or(highBlue.not());
  
  // Invertir: 1 = pixel válido (NO es nube)
  var validMask = cloudMask.not().or(highBlue.not().not());
  // Solo enmascara píxeles que son TANTO blancos COMO brillantes en azul
  var finalMask = whiteness.lt(params.threshold).or(highBlue.not());
  
  return image.updateMask(finalMask)
    .set('masklib_whiteness_threshold', params.threshold)
    .set('masklib_strategy', 'indices_whiteness');
};


/**
 * [ESTRATEGIA 1] Enmascara neblina y nubes tenues con el HOT (Haze Optimized Transform).
 * Desarrollado originalmente para Landsat, adaptado a SuperDove.
 * Nubes y neblina incrementan la reflectancia del Blue más que la del Red.
 *
 * HOT = Blue - 0.5 * Red - offset
 * Valores HOT positivos y altos → probable neblina/nube
 *
 * @param {ee.Image} image     - Imagen PlanetScope SuperDove.
 * @param {Object}   [params]  - Parámetros opcionales:
 *   @param {Number} [params.threshold=0.08] - Umbral HOT (en unidades de SR 0-1).
 *                                             Para imágenes en escala 0-10000 → usar ~800.
 *   @param {Boolean}[params.scaledSR=true]  - True si la imagen está en escala 0-10000.
 * @returns {ee.Image} Imagen enmascarada.
 *
 * @example
 * var masked = MASKLIB.PS.maskByHOT(image, {threshold: 500, scaledSR: true});
 */
MASKLIB.PS.maskByHOT = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    threshold: MASKLIB.PS._DEFAULTS.thresholds.hot,
    scaledSR: true
  });
  var b = MASKLIB.PS._DEFAULTS.bands;
  
  var blue = image.select(b.blue);
  var red  = image.select(b.red);
  
  // HOT = Blue - 0.5 * Red
  // Si la imagen está en escala 0-10000, el factor de offset también escala
  var hotOffset = params.scaledSR ? (params.threshold * 10000) : params.threshold;
  var hot = blue.subtract(red.multiply(0.5)).rename('HOT');
  
  // Valores HOT < threshold → claro (no neblina)
  var clearMask = hot.lt(hotOffset);
  
  return image.updateMask(clearMask)
    .set('masklib_hot_threshold', params.threshold)
    .set('masklib_strategy', 'indices_hot');
};


/**
 * [ESTRATEGIA 1] Enmascara sombras de nubes usando el NIR y Blue.
 * Las sombras presentan baja reflectancia general. El NIR es especialmente
 * sensible ya que la vegetación bajo sombra deja de emitir fuertemente en NIR.
 * El Blue también cae en sombras aunque no tanto como el NIR.
 *
 * LIMITACIÓN: puede confundirse con agua profunda o superficies muy oscuras.
 * Se recomienda combinar con una máscara de agua si es necesario.
 *
 * @param {ee.Image} image     - Imagen PlanetScope SuperDove.
 * @param {Object}   [params]  - Parámetros opcionales:
 *   @param {Number} [params.nirMax=1500]  - NIR máximo para considerar sombra (escala 0-10000).
 *   @param {Number} [params.blueMax=600]  - Blue máximo para considerar sombra (escala 0-10000).
 * @returns {ee.Image} Imagen enmascarada (sombras = 0).
 *
 * @example
 * var masked = MASKLIB.PS.maskShadowsByNIR(image, {nirMax: 1200, blueMax: 500});
 */
MASKLIB.PS.maskShadowsByNIR = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    nirMax:  MASKLIB.PS._DEFAULTS.thresholds.shadowNirMax,
    blueMax: MASKLIB.PS._DEFAULTS.thresholds.shadowBlueMax
  });
  var b = MASKLIB.PS._DEFAULTS.bands;
  
  var nir  = image.select(b.nir);
  var blue = image.select(b.blue);
  
  // Sombra: NIR bajo Y Blue bajo
  var isShadow = nir.lt(params.nirMax).and(blue.lt(params.blueMax));
  
  // Máscara válida: NO es sombra
  var validMask = isShadow.not();
  
  return image.updateMask(validMask)
    .set('masklib_shadow_nir_max', params.nirMax)
    .set('masklib_shadow_blue_max', params.blueMax)
    .set('masklib_strategy', 'indices_shadow_nir');
};


/**
 * [ESTRATEGIA 1] Enmascara píxeles con reflectancia anómalamente alta en Blue.
 * Método simple pero efectivo para nubes densas y brillantes.
 * Las nubes ópticas tienen muy alta reflectancia en el azul (> 0.2 SR ≈ 2000 en SR escalado).
 *
 * @param {ee.Image} image     - Imagen PlanetScope SuperDove.
 * @param {Object}   [params]  - Parámetros opcionales:
 *   @param {Number} [params.blueThreshold=2000] - Umbral de Blue (escala 0-10000).
 * @returns {ee.Image} Imagen enmascarada.
 *
 * @example
 * var masked = MASKLIB.PS.maskByBlueThreshold(image, {blueThreshold: 2500});
 */
MASKLIB.PS.maskByBlueThreshold = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    blueThreshold: MASKLIB.PS._DEFAULTS.thresholds.blueMin
  });
  var b = MASKLIB.PS._DEFAULTS.bands;
  
  // Píxeles con Blue < umbral → no son nubes brillantes
  var validMask = image.select(b.blue).lt(params.blueThreshold);
  
  return image.updateMask(validMask)
    .set('masklib_blue_threshold', params.blueThreshold)
    .set('masklib_strategy', 'indices_blue_threshold');
};


/**
 * [ESTRATEGIA 1 — COMBINADA] Enmascaramiento completo por índices espectrales.
 * Aplica NDSI + HOT + Sombras NIR en cascada.
 * Recomendado cuando NO se tiene acceso a bandas UDM2.
 *
 * El orden de aplicación es importante:
 *  1. NDSI: elimina nubes densas y brillantes
 *  2. HOT:  elimina neblina y nubes tenues
 *  3. NIR:  elimina sombras residuales
 *
 * @param {ee.Image} image     - Imagen PlanetScope SuperDove.
 * @param {Object}   [params]  - Parámetros opcionales (se pasan a cada sub-función):
 *   @param {Number}  [params.ndsiThreshold=0.8]  - Ver maskByNDSI.
 *   @param {Number}  [params.hotThreshold=0.08]  - Ver maskByHOT.
 *   @param {Number}  [params.nirMax=1500]         - Ver maskShadowsByNIR.
 *   @param {Number}  [params.blueMax=600]         - Ver maskShadowsByNIR.
 *   @param {Boolean} [params.maskShadows=true]    - Si aplica máscara de sombras.
 *   @param {Boolean} [params.maskHaze=true]       - Si aplica HOT para neblina.
 * @returns {ee.Image} Imagen enmascarada.
 *
 * @example
 * // Con parámetros por defecto
 * var masked = MASKLIB.PS.maskByIndices(image);
 *
 * // Personalizando umbrales
 * var masked = MASKLIB.PS.maskByIndices(image, {
 *   ndsiThreshold: 0.75,
 *   maskShadows: true,
 *   nirMax: 1200
 * });
 */
MASKLIB.PS.maskByIndices = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    ndsiThreshold: MASKLIB.PS._DEFAULTS.thresholds.ndsiCloud,
    hotThreshold:  MASKLIB.PS._DEFAULTS.thresholds.hot,
    nirMax:        MASKLIB.PS._DEFAULTS.thresholds.shadowNirMax,
    blueMax:       MASKLIB.PS._DEFAULTS.thresholds.shadowBlueMax,
    maskShadows:   true,
    maskHaze:      true
  });
  
  // Paso 1: Máscara por NDSI (nubes densas)
  var masked = MASKLIB.PS.maskByNDSI(image, {threshold: params.ndsiThreshold});
  
  // Paso 2: Máscara por HOT (neblina/nubes tenues)
  if (params.maskHaze) {
    masked = MASKLIB.PS.maskByHOT(masked, {
      threshold: params.hotThreshold,
      scaledSR: true
    });
  }
  
  // Paso 3: Máscara de sombras por NIR
  if (params.maskShadows) {
    masked = MASKLIB.PS.maskShadowsByNIR(masked, {
      nirMax:  params.nirMax,
      blueMax: params.blueMax
    });
  }
  
  return masked.set('masklib_strategy', 'indices_combined');
};


// ============================================================================
// ESTRATEGIA 2: ENMASCARAMIENTO POR BANDAS DE CALIDAD (UDM2)
// ============================================================================
// Usa el Usable Data Mask v2.1 de Planet, un modelo de deep learning (UNET)
// entrenado con decenas de miles de imágenes etiquetadas manualmente.
// Clases: Clear, Snow, Cloud Shadow, Haze, Cloud (Heavy Haze = 0 en UDM2.1).
//
// REQUISITO: La imagen debe haber sido ordenada como 'analytic_sr_udm2'
//             para tener las bandas Q1-Q8 disponibles en GEE.
//
// VENTAJAS:  Alta precisión (modelo ML). Directamente soportado por Planet.
//            Ofrece band-por-band control + nivel de confianza.
// DESVENTAJAS: Requiere asset UDM2 (no siempre disponible en imágenes pre-2018).
//              Puede perder nubes muy tenues (thin cirrus).
//
// REFERENCIA UDM2.1 (desde Nov 2023):
//   Q1 = Clear       (1 = claro, libre de nubes/sombras/nieve)
//   Q2 = Snow        (1 = nieve o hielo)
//   Q3 = Shadow      (1 = sombra de nube/neblina)
//   Q4 = Haze        (1 = neblina — fusión de Light Haze + Heavy Haze de v2.0)
//   Q5 = Heavy Haze  (siempre 0 en UDM2.1, mantenido por compatibilidad)
//   Q6 = Cloud       (1 = nube opaca)
//   Q7 = Confidence  (0–100 — confianza del modelo en la clasificación)
//   Q8 = Unusable    (bitwise — herencia de UDM1)
// ============================================================================

/**
 * [ESTRATEGIA 2] Enmascara nubes opacas usando la banda Q6 del UDM2.
 * Q6=1 indica píxeles con nubes opacas donde el suelo NO es visible.
 *
 * @param {ee.Image} image       - Imagen PlanetScope SuperDove con bandas UDM2.
 * @param {Object}   [params]    - Parámetros opcionales:
 *   @param {Number}  [params.minConfidence=0] - Confianza mínima del modelo (0-100).
 *                                               0 = acepta todas las predicciones.
 * @returns {ee.Image} Imagen con nubes enmascaradas.
 *
 * @example
 * var masked = MASKLIB.PS.maskCloudsByUDM2(image, {minConfidence: 60});
 */
MASKLIB.PS.maskCloudsByUDM2 = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    minConfidence: MASKLIB.PS._DEFAULTS.thresholds.udm2Confidence
  });
  var q = MASKLIB.PS._DEFAULTS.udm2;
  
  // Q6 = 0 → no es nube → píxel válido
  var notCloud = image.select(q.cloud).eq(0);
  
  // Si se requiere confianza mínima, aplica el filtro
  if (params.minConfidence > 0) {
    var highConfidence = image.select(q.confidence).gte(params.minConfidence);
    // Enmascara si: ES nube Y tiene alta confianza
    // Equivalente: válido si NO (es nube Y alta confianza) = NO es nube O baja confianza
    var isCloudHighConf = image.select(q.cloud).eq(1).and(highConfidence);
    notCloud = isCloudHighConf.not();
  }
  
  return image.updateMask(notCloud)
    .set('masklib_udm2_confidence', params.minConfidence)
    .set('masklib_strategy', 'udm2_cloud');
};


/**
 * [ESTRATEGIA 2] Enmascara sombras de nubes usando la banda Q3 del UDM2.
 * Q3=1 indica píxeles en sombra causados por nubes (no por terreno).
 *
 * @param {ee.Image} image       - Imagen PlanetScope SuperDove con bandas UDM2.
 * @param {Object}   [params]    - Parámetros opcionales:
 *   @param {Number}  [params.minConfidence=0] - Confianza mínima del modelo (0-100).
 * @returns {ee.Image} Imagen con sombras enmascaradas.
 *
 * @example
 * var masked = MASKLIB.PS.maskShadowsByUDM2(image);
 */
MASKLIB.PS.maskShadowsByUDM2 = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    minConfidence: MASKLIB.PS._DEFAULTS.thresholds.udm2Confidence
  });
  var q = MASKLIB.PS._DEFAULTS.udm2;
  
  // Q3 = 0 → no es sombra
  var notShadow = image.select(q.shadow).eq(0);
  
  if (params.minConfidence > 0) {
    var highConfidence = image.select(q.confidence).gte(params.minConfidence);
    var isShadowHighConf = image.select(q.shadow).eq(1).and(highConfidence);
    notShadow = isShadowHighConf.not();
  }
  
  return image.updateMask(notShadow)
    .set('masklib_udm2_confidence', params.minConfidence)
    .set('masklib_strategy', 'udm2_shadow');
};


/**
 * [ESTRATEGIA 2] Enmascara neblina usando la banda Q4 del UDM2.
 * Q4=1 indica neblina (filamentosa, polvo, humo). El suelo ES visible a través.
 * En UDM2.1 esta banda unifica Light Haze y Heavy Haze de la versión 2.0.
 *
 * NOTA: Enmascarar neblina es OPCIONAL según el análisis. La neblina permite
 * ver el suelo, pero puede afectar la reflectancia cuantitativamente.
 *
 * @param {ee.Image} image       - Imagen PlanetScope SuperDove con bandas UDM2.
 * @param {Object}   [params]    - Parámetros opcionales:
 *   @param {Number}  [params.minConfidence=0] - Confianza mínima del modelo.
 * @returns {ee.Image} Imagen con neblina enmascarada.
 *
 * @example
 * var masked = MASKLIB.PS.maskHazeByUDM2(image);
 */
MASKLIB.PS.maskHazeByUDM2 = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    minConfidence: MASKLIB.PS._DEFAULTS.thresholds.udm2Confidence
  });
  var q = MASKLIB.PS._DEFAULTS.udm2;
  
  // Q4 = 0 → no es neblina
  var notHaze = image.select(q.haze).eq(0);
  
  if (params.minConfidence > 0) {
    var highConfidence = image.select(q.confidence).gte(params.minConfidence);
    var isHazeHighConf = image.select(q.haze).eq(1).and(highConfidence);
    notHaze = isHazeHighConf.not();
  }
  
  return image.updateMask(notHaze)
    .set('masklib_strategy', 'udm2_haze');
};


/**
 * [ESTRATEGIA 2] Enmascara nieve/hielo usando la banda Q2 del UDM2.
 *
 * @param {ee.Image} image - Imagen PlanetScope SuperDove con bandas UDM2.
 * @returns {ee.Image} Imagen con nieve/hielo enmascarados.
 *
 * @example
 * var masked = MASKLIB.PS.maskSnowByUDM2(image);
 */
MASKLIB.PS.maskSnowByUDM2 = function(image) {
  var q = MASKLIB.PS._DEFAULTS.udm2;
  var notSnow = image.select(q.snow).eq(0);
  return image.updateMask(notSnow)
    .set('masklib_strategy', 'udm2_snow');
};


/**
 * [ESTRATEGIA 2] Usa directamente la banda Q1 (Clear) del UDM2.
 * Q1=1 indica que el píxel es CLARO (libre de nube, sombra, nieve y neblina).
 * Este es el método más directo y robusto cuando se dispone de UDM2.
 *
 * EQUIVALENTE A: enmascarar todo lo que NO sea "Clear" en una sola operación.
 *
 * @param {ee.Image} image       - Imagen PlanetScope SuperDove con bandas UDM2.
 * @param {Object}   [params]    - Parámetros opcionales:
 *   @param {Number}  [params.minConfidence=0] - Confianza mínima para aceptar "Clear".
 *                                               Alto valor = más conservador.
 * @returns {ee.Image} Imagen con solo píxeles "Clear" del UDM2.
 *
 * @example
 * // Solo píxeles clasificados como Clear con ≥70% de confianza del modelo
 * var masked = MASKLIB.PS.maskByClearBand(image, {minConfidence: 70});
 */
MASKLIB.PS.maskByClearBand = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    minConfidence: MASKLIB.PS._DEFAULTS.thresholds.udm2Confidence
  });
  var q = MASKLIB.PS._DEFAULTS.udm2;
  
  // Q1 = 1 → píxel claro → válido
  var isClear = image.select(q.clear).eq(1);
  
  // Opcionalmente filtra por confianza del modelo
  if (params.minConfidence > 0) {
    var highConfidence = image.select(q.confidence).gte(params.minConfidence);
    isClear = isClear.and(highConfidence);
  }
  
  return image.updateMask(isClear)
    .set('masklib_udm2_confidence', params.minConfidence)
    .set('masklib_strategy', 'udm2_clear_band');
};


/**
 * [ESTRATEGIA 2 — COMBINADA] Enmascaramiento completo usando UDM2.
 * Aplica máscaras de nube + sombra + (opcional) neblina + (opcional) nieve.
 * 
 * Existen DOS modos de operación (controlado por params.useClearBand):
 *   - useClearBand=true:  usa Q1 directamente (más simple y directo)
 *   - useClearBand=false: combina Q6 + Q3 + Q4 (más granular y configurable)
 *
 * @param {ee.Image} image       - Imagen PlanetScope SuperDove con bandas UDM2.
 * @param {Object}   [params]    - Parámetros opcionales:
 *   @param {Boolean} [params.maskClouds=true]     - Enmascara nubes opacas (Q6).
 *   @param {Boolean} [params.maskShadows=true]    - Enmascara sombras de nubes (Q3).
 *   @param {Boolean} [params.maskHaze=false]      - Enmascara neblina (Q4). Default=false.
 *   @param {Boolean} [params.maskSnow=false]      - Enmascara nieve (Q2). Default=false.
 *   @param {Boolean} [params.useClearBand=false]  - Usa Q1 directamente (ignora opciones arriba).
 *   @param {Number}  [params.minConfidence=0]     - Confianza mínima del modelo UDM2.
 * @returns {ee.Image} Imagen enmascarada.
 *
 * @example
 * // Modo estándar: nubes + sombras
 * var masked = MASKLIB.PS.maskByUDM2(image);
 *
 * // Modo agresivo: nubes + sombras + neblina, con alta confianza
 * var masked = MASKLIB.PS.maskByUDM2(image, {
 *   maskHaze: true,
 *   minConfidence: 70
 * });
 *
 * // Modo simple: solo usar banda Clear directamente
 * var masked = MASKLIB.PS.maskByUDM2(image, {useClearBand: true});
 */
MASKLIB.PS.maskByUDM2 = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    maskClouds:     true,
    maskShadows:    true,
    maskHaze:       false,
    maskSnow:       false,
    useClearBand:   false,
    minConfidence:  MASKLIB.PS._DEFAULTS.thresholds.udm2Confidence
  });
  
  // Modo directo: usa banda Clear (Q1)
  if (params.useClearBand) {
    return MASKLIB.PS.maskByClearBand(image, {minConfidence: params.minConfidence})
      .set('masklib_strategy', 'udm2_combined_clearband');
  }
  
  // Modo granular: combina bandas específicas
  var masked = image;
  
  if (params.maskClouds) {
    masked = MASKLIB.PS.maskCloudsByUDM2(masked, {minConfidence: params.minConfidence});
  }
  if (params.maskShadows) {
    masked = MASKLIB.PS.maskShadowsByUDM2(masked, {minConfidence: params.minConfidence});
  }
  if (params.maskHaze) {
    masked = MASKLIB.PS.maskHazeByUDM2(masked, {minConfidence: params.minConfidence});
  }
  if (params.maskSnow) {
    masked = MASKLIB.PS.maskSnowByUDM2(masked);
  }
  
  return masked.set('masklib_strategy', 'udm2_combined');
};


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

  // HOT: Haze Optimized Transform — neblina y nubes tenues
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
 * [ESTRATEGIA 3 — NÚCLEO] Entrena un clasificador Random Forest para nubes y sombras.
 *
 * Esta función realiza el entrenamiento del modelo. Sepárala de la clasificación
 * para poder reutilizar el mismo modelo en múltiples imágenes de la misma escena
 * o período, sin re-entrenar cada vez.
 *
 * CONVENCIÓN DE CLASES ESPERADA EN LAS FEATURECOLLECTIONS:
 *   Cada feature debe tener una propiedad (por defecto 'class') con valor numérico:
 *     cloudClass (default=1) → píxel de nube o sombra
 *     clearClass (default=0) → píxel claro
 *
 *   Ejemplo de estructura de un feature:
 *     ee.Feature(ee.Geometry.Point([lon, lat]), {'class': 1})  // nube
 *     ee.Feature(ee.Geometry.Point([lon, lat]), {'class': 0})  // claro
 *
 * @param {ee.Image}             trainingImage  - Imagen usada para extraer valores de entrenamiento.
 *                                               Debe ser la misma imagen (o similar) que se clasificará.
 *                                               Idealmente sin enmascarar previamente.
 * @param {ee.FeatureCollection} cloudSamples   - FeatureCollection con muestras de nubes/sombras.
 *                                               Geometrías: puntos o polígonos.
 * @param {ee.FeatureCollection} clearSamples   - FeatureCollection con muestras de píxeles claros.
 * @param {Object}               [params]       - Parámetros opcionales:
 *   @param {String}   [params.classProperty='class'] - Nombre de la propiedad con la clase.
 *   @param {Number}   [params.cloudClass=1]          - Valor numérico para nubes/sombras.
 *   @param {Number}   [params.clearClass=0]          - Valor numérico para píxeles claros.
 *   @param {Number}   [params.numTrees=100]          - Número de árboles del Random Forest.
 *                                                      Más árboles = más robusto pero más lento.
 *                                                      Rango recomendado: 50–200.
 *   @param {Boolean}  [params.addIndices=true]       - Agrega índices espectrales como features
 *                                                      (NDVI, NDSI, HOT, Whiteness, NDWI).
 *   @param {Number}   [params.scale=3]               - Escala en metros para muestrear la imagen.
 *                                                      3m = resolución nativa de SuperDove.
 *   @param {Number}   [params.tileScale=2]           - Factor de escala para operaciones en mosaico.
 *                                                      Aumentar si hay errores de memoria.
 * @returns {ee.Classifier} Clasificador Random Forest entrenado, listo para clasificar.
 *
 * @example
 * // Entrena el modelo con tus muestras
 * var classifier = MASKLIB.PS.trainCloudClassifier(image, cloudFC, clearFC);
 *
 * // Reutiliza el mismo clasificador en otra imagen
 * var masked1 = MASKLIB.PS.applyClassificationMask(image1, classifier);
 * var masked2 = MASKLIB.PS.applyClassificationMask(image2, classifier);
 */
MASKLIB.PS.trainCloudClassifier = function(trainingImage, cloudSamples, clearSamples, params) {
  params = MASKLIB.PS._mergeParams(params, {
    classProperty: 'class',
    cloudClass:    1,
    clearClass:    0,
    numTrees:      100,
    addIndices:    true,
    scale:         3,
    tileScale:     2
  });

  // Paso 1: Agrega índices espectrales si se solicita
  var imageForTraining = params.addIndices
    ? MASKLIB.PS._addSpectralIndicesForRF(trainingImage)
    : trainingImage;

  // Paso 2: Define las bandas que usará el clasificador
  // Siempre usa las 8 bandas ópticas; agrega índices si params.addIndices=true
  var b = MASKLIB.PS._DEFAULTS.bands;
  var opticalBands = [b.coastal, b.blue, b.greenI, b.green, b.yellow, b.red, b.redEdge, b.nir];
  var indexBands   = params.addIndices
    ? ['RF_NDVI', 'RF_NDSI', 'RF_HOT', 'RF_Whiteness', 'RF_NDWI']
    : [];
  var inputFeatures = opticalBands.concat(indexBands);

  // Paso 3: Prepara y combina FeatureCollections de entrenamiento
  var trainingFC = MASKLIB.PS._prepareTrainingData(
    cloudSamples,
    clearSamples,
    params.classProperty,
    params.cloudClass,
    params.clearClass
  );

  // Paso 4: Muestrea la imagen en las ubicaciones de entrenamiento
  // Extrae los valores de reflectancia (y índices) en cada punto/polígono de entrenamiento
  var trainingSamples = imageForTraining
    .select(inputFeatures)
    .sampleRegions({
      collection:  trainingFC,
      properties:  [params.classProperty],
      scale:       params.scale,
      tileScale:   params.tileScale,
      geometries:  false   // false = más eficiente; true = conserva geometría en el resultado
    });

  // Paso 5: Entrena el clasificador Random Forest
  var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees:        params.numTrees,
    variablesPerSplit:    null,   // null = sqrt(nFeatures) — estándar de RF
    minLeafPopulation:    1,
    bagFraction:          0.5,    // Fracción de muestras por árbol (bootstrap)
    maxNodes:             null,   // null = sin límite de profundidad
    seed:                 42      // Semilla para reproducibilidad
  })
  .train({
    features:       trainingSamples,
    classProperty:  params.classProperty,
    inputProperties: inputFeatures
  });

  // Adjunta metadata al clasificador para trazabilidad
  print('MaskLib RF: Clasificador entrenado.');
  print('MaskLib RF: Features usadas:', inputFeatures);
  print('MaskLib RF: Número de árboles:', params.numTrees);
  
  return classifier;
};


/**
 * [ESTRATEGIA 3 — NÚCLEO] Aplica un clasificador Random Forest pre-entrenado a una imagen.
 * Produce la clasificación y aplica la máscara de nubes/sombras.
 *
 * Esta función está separada de trainCloudClassifier() para permitir
 * reutilizar un modelo entrenado en múltiples imágenes sin re-entrenar.
 *
 * @param {ee.Image}      image         - Imagen PlanetScope SuperDove a clasificar y enmascarar.
 * @param {ee.Classifier} classifier    - Clasificador entrenado con trainCloudClassifier().
 * @param {Object}        [params]      - Parámetros opcionales:
 *   @param {Number}   [params.cloudClass=1]          - Valor de clase que será enmascarado.
 *   @param {Boolean}  [params.addIndices=true]       - Debe ser igual al usado en entrenamiento.
 *   @param {Boolean}  [params.addClassBand=false]    - Agrega la banda 'RF_class' al resultado.
 *                                                      Útil para visualizar/validar la clasificación.
 *   @param {Boolean}  [params.addProbBand=false]     - Agrega la banda 'RF_prob_cloud' (0-100).
 *                                                      Requiere modo PROBABILITY en el clasificador.
 * @returns {ee.Image} Imagen con máscara aplicada (nubes/sombras = 0).
 *
 * @example
 * var masked = MASKLIB.PS.applyClassificationMask(image, classifier);
 *
 * // Con banda de clasificación para validación visual
 * var masked = MASKLIB.PS.applyClassificationMask(image, classifier, {addClassBand: true});
 * Map.addLayer(masked.select('RF_class'), {min:0, max:1, palette:['green','white']}, 'Clasificación RF');
 */
MASKLIB.PS.applyClassificationMask = function(image, classifier, params) {
  params = MASKLIB.PS._mergeParams(params, {
    cloudClass:    1,
    addIndices:    true,
    addClassBand:  false,
    addProbBand:   false
  });

  // Paso 1: Prepara la imagen igual que durante el entrenamiento
  var imageForClassification = params.addIndices
    ? MASKLIB.PS._addSpectralIndicesForRF(image)
    : image;

  // Paso 2: Clasifica la imagen completa
  var classification = imageForClassification.classify(classifier).rename('RF_class');

  // Paso 3: Genera máscara — cloudClass = nube = enmascarar
  // cloudMask: 1 donde es nube (a eliminar), 0 donde es claro (a conservar)
  var cloudMask = classification.eq(params.cloudClass);

  // validMask: 1 donde NO es nube → píxeles a conservar
  var validMask = cloudMask.not();

  // Paso 4: Aplica la máscara a la imagen original (solo bandas ópticas)
  var masked = image.updateMask(validMask)
    .set('masklib_strategy',   'classification_rf')
    .set('masklib_cloud_class', params.cloudClass);

  // Paso 5 (opcional): Añade banda de clasificación para visualización/validación
  if (params.addClassBand) {
    masked = masked.addBands(classification);
  }

  return masked;
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
 * [ESTRATEGIA 3 — UTILIDAD INTERNA] Muestrea una FeatureCollection de forma
 * balanceada y estratificada por clase, garantizando igual cardinalidad entre clases.
 *
 * ALGORITMO:
 *   1. Muestrea la imagen en cloudSamples y clearSamples POR SEPARADO.
 *   2. Determina el mínimo de puntos disponibles entre ambas clases.
 *   3. Limita ambas clases a ese mínimo (usando randomColumn + sort + limit).
 *   4. Dentro de cada clase, divide train/val según trainFraction.
 *   5. Combina: trainCloud + trainClear → trainSet (balanceado).
 *              valCloud  + valClear   → valSet   (balanceado).
 *
 * RESULTADO:
 *   Si cloudSamples=50 y clearSamples=80, y trainFraction=0.7:
 *     - cardinalMin = 50
 *     - trainCloud=35, trainClear=35 → trainSet=70 (35+35)
 *     - valCloud=15,   valClear=15   → valSet=30   (15+15)
 *
 * @param {ee.Image}             image         - Imagen con bandas de features.
 * @param {ee.FeatureCollection} cloudSamples  - Muestras de nubes (ya con clase asignada).
 * @param {ee.FeatureCollection} clearSamples  - Muestras claras (ya con clase asignada).
 * @param {Array}                inputFeatures - Nombres de bandas a muestrear.
 * @param {String}               classProperty - Nombre de la propiedad de clase.
 * @param {Number}               scale         - Escala de muestreo en metros.
 * @param {Number}               tileScale     - TileScale para sampleRegions.
 * @param {Number}               trainFraction - Fracción para entrenamiento (0–1).
 * @returns {Object} {trainSet, valSet, cardinalMin, nTrain, nVal}
 */
MASKLIB.PS._stratifiedSplit = function(image, cloudSamples, clearSamples,
                                       inputFeatures, classProperty,
                                       scale, tileScale, trainFraction) {

  // ── Paso 1: Muestrea cada clase de forma independiente ──────────────────────
  // Muestrear por separado garantiza que cada clase tenga su propia columna
  // aleatoria, evitando desbalance introducido por el orden de los features.

  var sampledCloud = image
    .select(inputFeatures)
    .sampleRegions({
      collection: cloudSamples,
      properties: [classProperty],
      scale:      scale,
      tileScale:  tileScale
    })
    .randomColumn('_rand', 42);   // Semilla fija → reproducibilidad

  var sampledClear = image
    .select(inputFeatures)
    .sampleRegions({
      collection: clearSamples,
      properties: [classProperty],
      scale:      scale,
      tileScale:  tileScale
    })
    .randomColumn('_rand', 42);

  // ── Paso 2: Cardinalidad mínima entre clases ────────────────────────────────
  // Se opera en el servidor GEE: .size() devuelve ee.Number, no un JS Number.
  var nCloud = sampledCloud.size();
  var nClear = sampledClear.size();
  var cardinalMin = nCloud.min(nClear);  // ee.Number.min() → mínimo server-side

  // sort('_rand') baraja aleatoriamente (orden reproducible con semilla 42).
  // limit(cardinalMin) toma exactamente n puntos de cada clase.
  var cloudShuffled = sampledCloud.sort('_rand').limit(cardinalMin);
  var clearShuffled = sampledClear.sort('_rand').limit(cardinalMin);

  // ── Paso 4: Split por tamaño garantizado, NO por umbral de _rand ─────────────
  // nTrain = floor(cardinalMin * trainFraction)  → enteros exactos para limit().
  // nVal   = cardinalMin - nTrain               → complemento exacto.
  //
  // Usar limit() en lugar de filter(lt/_rand) GARANTIZA que ambos splits
  // siempre tengan puntos, sin importar la distribución de los valores aleatorios.
  //
  // Train: primeros nTrain puntos del shuffle (orden ascendente _rand).
  // Val:   últimos  nVal   puntos del shuffle (orden descendente _rand).
  // Como el shuffle es el mismo, train y val son conjuntos complementarios.
  var nTrain = cardinalMin.multiply(trainFraction).floor();
  var nVal   = cardinalMin.subtract(nTrain);

  var cloudTrain = cloudShuffled.limit(nTrain);
  var clearTrain = clearShuffled.limit(nTrain);

  var cloudVal   = cloudShuffled.sort('_rand', false).limit(nVal);
  var clearVal   = clearShuffled.sort('_rand', false).limit(nVal);

  // ── Paso 5: Combinar train y val balanceados ────────────────────────────────
  // trainSet: nTrain puntos cloud + nTrain puntos clear
  // valSet:   nVal   puntos cloud + nVal   puntos clear
  var trainSet = cloudTrain.merge(clearTrain);
  var valSet   = cloudVal.merge(clearVal);

  return {
    trainSet:    trainSet,
    valSet:      valSet,
    nCloud:      nCloud,
    nClear:      nClear,
    cardinalMin: cardinalMin
  };
};

/**
 * [ESTRATEGIA 3 — UTILIDAD] Evalúa la precisión del clasificador Random Forest.
 *
 * DIVISIÓN BALANCEADA Y ESTRATIFICADA POR CLASE:
 *   La separación train/val se hace por clase de forma independiente, garantizando:
 *   1. Misma cardinalidad entre clases (limitada al mínimo disponible).
 *   2. La misma proporción train/val dentro de cada clase.
 *
 *   Ejemplo con cloudSamples=50, clearSamples=80, trainFraction=0.7:
 *     cardinalMin = 50
 *     Train → 35 cloud  + 35 clear = 70 puntos  (balanceado)
 *     Val   → 15 cloud  + 15 clear = 30 puntos  (balanceado)
 *
 * RECOMENDADO ejecutar antes de usar el clasificador en producción.
 *
 * @param {ee.Image}             image         - Imagen de entrenamiento/validación.
 * @param {ee.FeatureCollection} cloudSamples  - Muestras de nubes/sombras.
 * @param {ee.FeatureCollection} clearSamples  - Muestras de píxeles claros.
 * @param {Object}               [params]      - Parámetros opcionales:
 *   @param {String}  [params.classProperty='class'] - Nombre de la propiedad de clase.
 *   @param {Number}  [params.cloudClass=1]          - Valor numérico de la clase nube.
 *   @param {Number}  [params.clearClass=0]          - Valor numérico de la clase claro.
 *   @param {Number}  [params.numTrees=100]          - Árboles del Random Forest.
 *   @param {Boolean} [params.addIndices=true]       - Agrega índices espectrales como features.
 *   @param {Number}  [params.scale=3]               - Escala de muestreo en metros.
 *   @param {Number}  [params.tileScale=2]           - TileScale para sampleRegions.
 *   @param {Number}  [params.trainFraction=0.7]     - Proporción de muestras para entrenamiento.
 * @returns {void} Imprime en consola: cardinalidades, splits, matriz de confusión y métricas.
 *
 * @example
 * // Con 50 puntos cloud y 80 puntos clear:
 * //   → usará 50 de cada clase (cardinalMin=50)
 * //   → train: 35 cloud + 35 clear = 70 | val: 15 cloud + 15 clear = 30
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
    trainFraction: 0.7
  });

  // ── Prepara imagen con índices ──────────────────────────────────────────────
  var imageForEval = params.addIndices
    ? MASKLIB.PS._addSpectralIndicesForRF(image)
    : image;

  var b = MASKLIB.PS._DEFAULTS.bands;
  var opticalBands  = [b.coastal, b.blue, b.greenI, b.green, b.yellow, b.red, b.redEdge, b.nir];
  var indexBands    = params.addIndices
    ? ['RF_NDVI', 'RF_NDSI', 'RF_HOT', 'RF_Whiteness', 'RF_NDWI']
    : [];
  var inputFeatures = opticalBands.concat(indexBands);

  // ── Normaliza los valores de clase en las FCs ───────────────────────────────
  var cloudFC = cloudSamples.map(function(f) {
    return f.set(params.classProperty, params.cloudClass);
  });
  var clearFC = clearSamples.map(function(f) {
    return f.set(params.classProperty, params.clearClass);
  });

  // ── División balanceada y estratificada por clase ───────────────────────────
  var split = MASKLIB.PS._stratifiedSplit(
    imageForEval,
    cloudFC,
    clearFC,
    inputFeatures,
    params.classProperty,
    params.scale,
    params.tileScale,
    params.trainFraction
  );

  var trainSet = split.trainSet;
  var valSet   = split.valSet;

  // ── Entrena el clasificador con el trainSet balanceado ──────────────────────
  var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees: params.numTrees,
    seed:          42
  })
  .train({
    features:        trainSet,
    classProperty:   params.classProperty,
    inputProperties: inputFeatures
  });

  // ── Clasifica el valSet y calcula la matriz de confusión ────────────────────
  var validated  = valSet.classify(classifier);
  var confMatrix = validated.errorMatrix(params.classProperty, 'classification');

  // ── Imprime reporte completo en consola GEE ─────────────────────────────────
  print('─── MaskLib RF — Evaluación del Clasificador ───');
  print('Puntos cloud provistos:',    split.nCloud);
  print('Puntos clear provistos:',    split.nClear);
  print('Cardinalidad mínima usada:', split.cardinalMin);
  print('trainFraction:',             params.trainFraction);
  print('──────────────────────────────');
  print('Train: ~' + params.trainFraction * 100 + '% por clase × 2 clases');
  print('Val:   ~' + (1 - params.trainFraction) * 100 + '% por clase × 2 clases');
  print('Total train set:', trainSet.size());
  print('Total val set:',   valSet.size());
  print('──────────────────────────────');
  print('Matriz de Confusión:',                  confMatrix);
  print('Exactitud Global:',                     confMatrix.accuracy());
  print('Índice Kappa:',                         confMatrix.kappa());
  print('Exactitud por clase (Producers):',      confMatrix.producersAccuracy());
  print('Exactitud por clase (Consumers):',      confMatrix.consumersAccuracy());
  print('─────────────────────────────────────────────────');
};

// ============================================================================
// FUNCIÓN UNIFICADA: maskClouds
// ============================================================================
// Punto de entrada principal para enmascarar nubes y sombras.
// Elige automáticamente la estrategia según disponibilidad de UDM2,
// o permite forzar una estrategia específica.
// ============================================================================

/**
 * [FUNCIÓN PRINCIPAL] Enmascara nubes y sombras en una imagen PlanetScope SuperDove.
 * Esta es la función recomendada para uso general.
 *
 * Lógica de selección automática de estrategia:
 *   1. Si strategy='udm2'           → usa UDM2 (requiere Q1-Q8)
 *   2. Si strategy='indices'        → usa índices espectrales
 *   3. Si strategy='combined'       → UDM2 primero, luego refinamiento con índices
 *   4. Si strategy='classification' → Random Forest (requiere cloudSamples + clearSamples)
 *   5. Si strategy='auto'           → asume UDM2 (especifica para mayor control)
 *
 * @param {ee.Image} image      - Imagen PlanetScope SuperDove.
 *                                Con UDM2: 12 bandas (B1-B8 + Q1-Q8).
 *                                Sin UDM2: 8 bandas (B1-B8).
 * @param {Object}  [params]    - Parámetros opcionales:
 *   @param {String}  [params.strategy='auto']  - Estrategia de enmascaramiento:
 *                                'auto'           → asume udm2 por defecto
 *                                'udm2'           → bandas de calidad UDM2
 *                                'indices'        → índices espectrales
 *                                'combined'       → UDM2 + índices
 *                                'classification' → Random Forest supervisado
 *   @param {Boolean} [params.maskClouds=true]   - Enmascara nubes.
 *   @param {Boolean} [params.maskShadows=true]  - Enmascara sombras.
 *   @param {Boolean} [params.maskHaze=false]    - Enmascara neblina.
 *   @param {Number}  [params.minConfidence=0]   - Confianza mínima UDM2.
 *
 *   Parámetros exclusivos de strategy='classification':
 *   @param {ee.FeatureCollection} [params.cloudSamples]   - Muestras de nubes/sombras.
 *   @param {ee.FeatureCollection} [params.clearSamples]   - Muestras de píxeles claros.
 *   @param {String}  [params.classProperty='class']       - Propiedad de clase en las FC.
 *   @param {Number}  [params.cloudClass=1]                - Valor de clase nube.
 *   @param {Number}  [params.clearClass=0]                - Valor de clase claro.
 *   @param {Number}  [params.numTrees=100]                - Árboles del Random Forest.
 *   @param {Boolean} [params.addClassBand=false]          - Añade banda de clasificación.
 *
 * @returns {ee.Image} Imagen con máscara de nubes y sombras aplicada.
 *
 * @example
 * // Estrategia UDM2
 * var masked = MASKLIB.PS.maskClouds(image, {strategy: 'udm2'});
 *
 * // Estrategia índices
 * var masked = MASKLIB.PS.maskClouds(image, {strategy: 'indices'});
 *
 * // Estrategia Random Forest
 * var masked = MASKLIB.PS.maskClouds(image, {
 *   strategy:      'classification',
 *   cloudSamples:  myCloudFC,
 *   clearSamples:  myClearFC,
 *   numTrees:      150
 * });
 *
 * // Aplicar a colección con RF (entrena una vez, aplica a todas)
 * var classifier = MASKLIB.PS.trainCloudClassifier(refImage, cloudFC, clearFC);
 * var maskedCol = collection.map(function(img) {
 *   return MASKLIB.PS.applyClassificationMask(img, classifier);
 * });
 */
MASKLIB.PS.maskClouds = function(image, params) {
  params = MASKLIB.PS._mergeParams(params, {
    strategy:       'auto',
    maskClouds:     true,
    maskShadows:    true,
    maskHaze:       false,
    maskSnow:       false,
    minConfidence:  0,
    // Parámetros RF (solo aplican si strategy='classification')
    cloudSamples:   null,
    clearSamples:   null,
    classProperty:  'class',
    cloudClass:     1,
    clearClass:     0,
    numTrees:       100,
    addIndices:     true,
    addClassBand:   false
  });

  var strategy = params.strategy;

  // Auto-detección: asume UDM2 si no se especifica
  if (strategy === 'auto') {
    strategy = 'udm2';
    // NOTA: Para colecciones, especifica la estrategia explícitamente
    // para evitar suposiciones incorrectas sobre las bandas disponibles
  }

  // ── Estrategia UDM2 ──
  if (strategy === 'udm2') {
    return MASKLIB.PS.maskByUDM2(image, {
      maskClouds:    params.maskClouds,
      maskShadows:   params.maskShadows,
      maskHaze:      params.maskHaze,
      maskSnow:      params.maskSnow,
      minConfidence: params.minConfidence
    });

  // ── Estrategia Índices Espectrales ──
  } else if (strategy === 'indices') {
    return MASKLIB.PS.maskByIndices(image, {
      maskShadows: params.maskShadows,
      maskHaze:    params.maskHaze
    });

  // ── Estrategia Combinada (UDM2 + Índices) ──
  } else if (strategy === 'combined') {
    var udm2Masked = MASKLIB.PS.maskByUDM2(image, {
      maskClouds:    params.maskClouds,
      maskShadows:   params.maskShadows,
      maskHaze:      params.maskHaze,
      minConfidence: params.minConfidence
    });
    return MASKLIB.PS.maskByIndices(udm2Masked, {
      maskShadows: params.maskShadows,
      maskHaze:    params.maskHaze
    });

  // ── Estrategia Clasificación Random Forest ──
  } else if (strategy === 'classification') {
    if (!params.cloudSamples || !params.clearSamples) {
      throw new Error(
        'MaskLib ERROR [maskClouds]: strategy="classification" requiere ' +
        'params.cloudSamples y params.clearSamples.'
      );
    }
    return MASKLIB.PS.maskByClassification(image, {
      cloudSamples:  params.cloudSamples,
      clearSamples:  params.clearSamples,
      classProperty: params.classProperty,
      cloudClass:    params.cloudClass,
      clearClass:    params.clearClass,
      numTrees:      params.numTrees,
      addIndices:    params.addIndices,
      addClassBand:  params.addClassBand
    });

  // ── Fallback ──
  } else {
    print('MaskLib WARNING: Estrategia "' + strategy + '" no reconocida. Usando índices.');
    return MASKLIB.PS.maskByIndices(image);
  }
};


// ============================================================================
// FUNCIÓN DE INSPECCIÓN / DEBUG
// ============================================================================

/**
 * Muestra en consola el estado de las bandas UDM2 de una imagen.
 * Útil para debugging y verificar que la imagen tiene el formato correcto.
 *
 * @param {ee.Image} image - Imagen PlanetScope SuperDove.
 * @param {String}   [label='MaskLib Inspect'] - Etiqueta para el print.
 *
 * @example
 * MASKLIB.PS.inspect(image, 'Mi imagen SuperDove');
 */
MASKLIB.PS.inspect = function(image, label) {
  label = label || 'MaskLib Inspect';
  print('--- ' + label + ' ---');
  print('Bandas disponibles:', image.bandNames());
  
  var bandNames = image.bandNames();
  var hasUDM2 = bandNames.contains('Q1');
  print('¿Tiene UDM2?', hasUDM2);
  
  // Estadísticas de bandas UDM2 si están disponibles
  var q = MASKLIB.PS._DEFAULTS.udm2;
  var udm2Bands = [q.clear, q.snow, q.shadow, q.haze, q.cloud, q.confidence];
  
  // Reducción de imagen para obtener porcentajes (requiere definir geometría)
  // Comentado por defecto para no forzar una geometría específica
  // Para usarlo: MASKLIB.PS.inspect(image.clip(roi), 'Mi imagen', roi)
  print('Para estadísticas de píxeles, usa image.reduceRegion() con tu ROI.');
};


// ============================================================================
// STUBS PENDIENTES — Otros sensores (próximas fases)
// ============================================================================

/**
 * [PENDIENTE - FASE 2] Enmascaramiento para Sentinel-2.
 * @todo Implementar estrategias 1 y 2 para Sentinel-2 MSI.
 */
MASKLIB.S2.maskClouds = function(image, params) {
  throw new Error('MaskLib: Sentinel-2 aún no implementado. Ver Fase 2 del roadmap.');
};

/**
 * [PENDIENTE - FASE 3] Enmascaramiento para Landsat 8/9.
 * @todo Implementar estrategias 1 y 2 para Landsat OLI.
 */
MASKLIB.LS.maskClouds = function(image, params) {
  throw new Error('MaskLib: Landsat 8/9 aún no implementado. Ver Fase 3 del roadmap.');
};


// ============================================================================
// EJEMPLOS DE USO COMPLETOS
// ============================================================================
/*

var visParams = {bands: ['B6', 'B4', 'B2'], min: 0, max: 3000};
var image = ee.Image('projects/tu-proyecto/assets/superdove_image');

// ─────────────────────────────────────────────────────────────────────────────
// EJEMPLO A: Las tres estrategias comparadas lado a lado
// ─────────────────────────────────────────────────────────────────────────────

// Estrategia 1: Índices espectrales (no requiere UDM2)
var maskedIndices = MASKLIB.PS.maskClouds(image, {strategy: 'indices'});

// Estrategia 2: UDM2 con neblina y confianza mínima 60%
var maskedUDM2 = MASKLIB.PS.maskClouds(image, {
  strategy:      'udm2',
  maskHaze:      true,
  minConfidence: 60
});

// Estrategia 3: Random Forest con muestras propias
var cloudFC = ee.FeatureCollection([
  ee.Feature(ee.Geometry.Point([-75.12, 4.56]), {'class': 1}),
  ee.Feature(ee.Geometry.Point([-75.23, 4.67]), {'class': 1})
]);
var clearFC = ee.FeatureCollection([
  ee.Feature(ee.Geometry.Point([-75.34, 4.78]), {'class': 0}),
  ee.Feature(ee.Geometry.Point([-75.45, 4.89]), {'class': 0})
]);
var maskedRF = MASKLIB.PS.maskClouds(image, {
  strategy:     'classification',
  cloudSamples: cloudFC,
  clearSamples: clearFC,
  numTrees:     150,
  addClassBand: true
});

// Combinado: UDM2 + refinamiento por índices
var maskedCombined = MASKLIB.PS.maskClouds(image, {strategy: 'combined'});

Map.addLayer(image,          visParams, 'Original');
Map.addLayer(maskedIndices,  visParams, 'Estrategia 1 — Índices');
Map.addLayer(maskedUDM2,     visParams, 'Estrategia 2 — UDM2');
Map.addLayer(maskedRF,       visParams, 'Estrategia 3 — Random Forest');
Map.addLayer(maskedCombined, visParams, 'Estrategia combinada');

// Visualizar la clasificación RF
Map.addLayer(
  maskedRF.select('RF_class'),
  {min:0, max:1, palette: ['00AA00', 'FFFFFF']},
  'Clasificación RF (verde=claro, blanco=nube)'
);

// ─────────────────────────────────────────────────────────────────────────────
// EJEMPLO B: RF eficiente para colecciones — entrena una vez, aplica a todas
// ─────────────────────────────────────────────────────────────────────────────

var collection = ee.ImageCollection('projects/tu-proyecto/assets/superdove_col')
  .filterDate('2023-01-01', '2023-12-31')
  .filterBounds(roi);

// Entrena el clasificador con UNA imagen representativa
var refImage = collection.first();
var classifier = MASKLIB.PS.trainCloudClassifier(refImage, cloudFC, clearFC, {
  numTrees:   150,
  addIndices: true
});

// Evalúa la precisión antes de aplicar en producción
MASKLIB.PS.evaluateClassifier(refImage, cloudFC, clearFC, {numTrees: 150});

// Aplica el clasificador pre-entrenado a toda la colección
var maskedCol = collection.map(function(img) {
  return MASKLIB.PS.applyClassificationMask(img, classifier);
});

var composite = maskedCol.median();
Map.addLayer(composite, visParams, 'Compuesto RF sin nubes');

// ─────────────────────────────────────────────────────────────────────────────
// EJEMPLO C: Muestras desde assets GEE + validación de precisión
// ─────────────────────────────────────────────────────────────────────────────

var cloudAsset = ee.FeatureCollection('projects/mi-proyecto/assets/cloud_samples');
var clearAsset = ee.FeatureCollection('projects/mi-proyecto/assets/clear_samples');

// Primero evalúa la precisión
MASKLIB.PS.evaluateClassifier(image, cloudAsset, clearAsset, {
  numTrees:      200,
  addIndices:    true,
  trainFraction: 0.7
});

// Si la precisión es aceptable (ej. Kappa > 0.8), aplica
var maskedFinal = MASKLIB.PS.maskByClassification(image, {
  cloudSamples:  cloudAsset,
  clearSamples:  clearAsset,
  numTrees:      200,
  addIndices:    true,
  addClassBand:  true
});

// ─────────────────────────────────────────────────────────────────────────────
// EJEMPLO D: Inspección y funciones individuales
// ─────────────────────────────────────────────────────────────────────────────

MASKLIB.PS.inspect(image, 'Mi SuperDove');

var onlyClouds  = MASKLIB.PS.maskCloudsByUDM2(image, {minConfidence: 80});
var onlyShadows = MASKLIB.PS.maskShadowsByNIR(image, {nirMax: 1000, blueMax: 400});
var onlyBright  = MASKLIB.PS.maskByNDSI(image, {threshold: 0.85});

*/

// ============================================================================
// FIN DE MASKLIB v0.2 — PlanetScope SuperDove
// ============================================================================
// Fase 1 COMPLETA: Estrategias 1 (Índices), 2 (UDM2), 3 (Random Forest)
// Próximo: Fase 2 — Sentinel-2 (estrategias 1, 2 y 3)
// Roadmap: https://github.com/[tu-usuario]/masklib
// ============================================================================