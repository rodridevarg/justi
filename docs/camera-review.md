# Revisión del arranque de cámara — Body Dodge

Revisión del código de `main` en `6bbec782966d2cb6b403e1a70533d9a388a10b85`, realizada el 25 de octubre de 2026. Se revisaron los permisos, la reproducción del video, la carga de MediaPipe, la calibración, el inicio/reinicio de partidas, la cancelación y el manejo de errores.

## Hallazgos y correcciones

1. **P1: la dependencia principal devuelve 404.** `game.js:638–639` y el worker antiguo apuntaban a `@mediapipe/tasks-vision@0.10.22`. El bundle y WASM responden HTTP 404. La cámara se autoriza primero y la importación falla después, por lo que el juego vuelve al inicio. Se fijó la versión publicada `0.10.21`, compartida por JS y WASM en `pose-detector.mjs`. Se comprobaron HTTP 200 para el bundle, los cuatro archivos WASM/JS SIMD y sin SIMD, y el modelo. Se agregó una verificación de red en CI para detectar futuras referencias rotas.

2. **P1: errores poco visibles y cuenta regresiva activa después de fallar.** `failCamera`, antes en `game.js:769`, colocaba el mensaje dentro del texto de introducción y no cancelaba el temporizador de inicio. Un fallo durante la cuenta regresiva podía ser tapado por el siguiente callback. Ahora se detienen temporizadores, detector y cámara, y se muestra un aviso persistente con `role="alert"` fuera del área del juego que recorta su contenido. Se diferencia entre permiso, cámara ocupada, reproducción del video y carga del detector.

3. **P2: cancelar durante la carga bloqueaba los botones.** `backToHome`, antes en `game.js:952`, no rehabilitaba los botones deshabilitados por `startCamera`. Ahora restaura ambos controles y cualquier stream o detector que termine de abrirse después de cancelar se cierra sin modificar la pantalla actual.

4. **P2: el inicio y el reinicio con cámara omitían parte del ciclo de juego.** `startCamera:699–703` iniciaba directamente la cuenta regresiva; `beginGame:836` rechazaba el estado de fin de partida, por lo que «Una más» no funcionaba. Ahora ambos caminos reinician puntuación, vidas, obstáculos y pausa mediante `beginGame`. Si la pose está desactualizada, se vuelve a calibrar.

5. **P2: calibración con muestras discontinuas y encuadre incompleto.** Se acumulaban muestras incluso si se perdía el cuerpo entre ellas; las instrucciones pedían solo cabeza y hombros aunque `extractBody` exige también caderas. Ahora se requieren detecciones consecutivas y las instrucciones incluyen hombros y caderas.

6. **P2: carga sin límite y vista de cámara tardía.** El arranque podía quedar esperando indefinidamente una descarga o la reproducción del video. Ahora hay límites de 45 segundos para el detector y 12 segundos para el video. El permiso puede seguir esperando una respuesta del usuario. La vista previa aparece en cuanto empieza el video, antes de terminar la carga del detector. Se conservan controles de sesión y se cierran recursos que resuelven tarde.

Se eliminó `pose-worker.js`, que ya no era utilizado por el juego y mantenía la referencia rota. Se conserva el procesamiento en el hilo principal con GPU y alternativa CPU que ya existía en `main`.

También se corrigió el reloj de partida: el delta limitado para animaciones reducía el tiempo contado cuando el renderizado se demoraba, algo relevante con inferencia en celulares. El juego ahora cuenta el tiempo real entre frames y pausa al pasar la pestaña a segundo plano.

## Validación

- `node --test tests/*.test.mjs`: 14 pruebas de regresión de errores, cancelación, recursos tardíos, GPU/CPU, calibración, inicio/reinicio, movimientos, agacharse, colisiones y tiempo real de partida.
- `node tests/check-assets.mjs`: las seis URLs responden HTTP 200.
- `node --check game.js`: sintaxis válida.
- Prueba en navegador real a 390 píxeles de ancho: descarga real de MediaPipe/WASM/modelo, detección sobre video sintético de la imagen pública `mediapipe-assets/pose.jpg`, calibración completa, inicio de partida y aumento del puntaje.
- Prueba de fallo después del permiso: el aviso se mantiene visible y ambos modos pueden volver a iniciarse.

Para repetir las pruebas de navegador, iniciá un servidor local en la raíz del proyecto y abrí `tests/browser-camera.html`. Esa página usa video sintético; no pide acceso a la cámara del dispositivo.

## Límites

El fallo de las URLs se reprodujo y se corrigió. La prueba de navegador ejecuta el detector real, pero no reemplaza una prueba con la cámara física del Samsung. El rendimiento de la inferencia en el hilo principal y la sensibilidad de las sentadillas siguen dependiendo del teléfono, la luz y el encuadre.

