# BODY DODGE

**Un juego gratuito de reflejos: esquivá obstáculos moviéndote. La cámara reconoce tu postura; también podés jugar con teclado o controles táctiles.**

Este prototipo funciona como sitio estático: no lleva cuentas, backend, instalación, dependencias de compilación ni una subida de imágenes. **MediaPipe recibe imágenes en tu dispositivo** dentro del navegador. Las conexiones externas solo cargan el detector, el modelo y las tipografías.

## Jugar

- **Con cámara:** abrí el juego en una versión HTTPS publicada, o desde `localhost` en tu computadora; aceptá el acceso y quedá a la vista de hombros a cadera. Esperá a que se calibre y pulsá «Empezar partida».
- **Sin cámara:** elegí «Probar con teclado».
- **Esquivá:** movete a izquierda o derecha para cambiar de carril; agachate para pasar debajo de las barras luminosas. Evitá las cajas en los otros carriles.
- **Teclado:** ←/A, →/D, ↓/S/barra espaciadora para agacharse y P o Escape para pausar.
- **Pantalla táctil:** usá los botones debajo de la pista. Podés mantener presionado «Agacharse».
- **Objetivo:** sobreviví 30 segundos. Los obstáculos se acercan más rápido a medida que avanza la partida.

## Ejecutar en una computadora

Instalá Python 3. En la carpeta del proyecto ejecutá `python3 -m http.server 8000` (Windows: `python -m http.server 8000`) y abrí [http://localhost:8000](http://localhost:8000) en Chrome o Edge. Aceptá el permiso de cámara. Si la cámara no aparece, revisá los permisos del navegador y volvé a intentarlo.

Abrir los archivos directamente como `file://` no habilita la cámara. El acceso también requiere luz suficiente, un encuadre de medio cuerpo y una conexión a internet para cargar el modelo de MediaPipe la primera vez.

## Publicar en GitHub Pages

El workflow de Actions incluido publica el contenido estático cada vez que `main` recibe un commit. En **Settings → Pages**, elegí **GitHub Actions** como origen de publicación. Cuando termine la primera ejecución, abrí `https://rodridevarg.github.io/justi/`. La cámara del teléfono requiere esa URL HTTPS. No hace falta instalar una app ni iniciar sesión para jugar.

## Qué incluye v0.1

- MediaPipe Pose Landmarker para detectar hombros y caderas, calibrar la posición inicial, moverse entre tres carriles y reconocer una sentadilla.
- Vista de cámara local con puntos de referencia del esqueleto y pausa automática si el detector pierde la pose.
- Pista Canvas con obstáculos, efectos visuales, vidas, multiplicador, puntaje y partidas de 30 segundos.
- Controles táctiles, teclado, pausa, reinicio y pantalla completa, con una interfaz adaptable.
- Deploy automático de GitHub Pages desde `main`.

Los rankings, los perfiles, el juego en línea, los saltos y la grabación de partidas quedan fuera de esta primera entrega. La sensibilidad del seguimiento y la velocidad de los obstáculos son un punto de partida; conviene ajustarlas después de jugar unas primeras partidas con distintas cámaras.

## Cámara y comprobaciones

El detector usa la versión publicada `0.10.21` de MediaPipe, con JS y WASM de la misma versión. Si falla el arranque, aparece un aviso arriba de la pista con la causa y una acción para volver a intentarlo. La vista previa aparece mientras se prepara el detector. La calibración requiere que se vean hombros y caderas durante varias detecciones consecutivas.

Con Node.js 22 o posterior, ejecutá `node --test tests/*.test.mjs` para las pruebas de regresión y `node tests/check-assets.mjs` para comprobar las descargas externas. Este último comando necesita Internet. GitHub Actions ejecuta ambos al abrir un PR y al actualizar `main`; el juego sigue sin necesitar compilación ni instalación de paquetes.

Para comprobar el detector real sin cámara, iniciá el servidor local y abrí `tests/browser-camera.html`. Incluye una prueba de calibración con video sintético y otra de fallo de descarga. Los hallazgos y los límites de la revisión están en [docs/camera-review.md](docs/camera-review.md).



