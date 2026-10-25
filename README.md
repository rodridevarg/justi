# BODY BEAT

**Tu cuerpo es el joystick. Seguí las flechas que caen y bailá al ritmo.** Body Beat es un juego web gratuito que funciona en el navegador, sin cuentas ni instalación.

## Jugar

- **Con cámara:** abrí la versión publicada en HTTPS o usá `localhost`, aceptá el permiso y parate a una distancia donde se vean hombros y caderas. Después de calibrar, seguí las flechas con pasos laterales, brazos arriba y agachadas.
- **Sin cámara:** elegí «Probar sin cámara». Los botones táctiles y las flechas del teclado disparan los mismos pasos.
- **Controles:** ←/A para izquierda, →/D para derecha, ↑/W para brazos arriba y ↓/S/espacio para agacharse. P o Escape pausa la partida.
- **Objetivo:** acertá las flechas cuando llegan a la línea. «Perfect» y «Bien» suman puntos; tres pasos perdidos seguidos consumen una vida. La pista dura 30 segundos.

El detector MediaPipe y el juego se ejecutan en el dispositivo. Las imágenes de la cámara no se suben a un servidor.

## Ejecutar en una computadora

Desde la carpeta del proyecto iniciá un servidor estático con `python3 -m http.server 8000` (Windows: `python -m http.server 8000`) y abrí [http://localhost:8000](http://localhost:8000) en Chrome o Edge. `file://` no habilita cámara. La primera carga necesita Internet para descargar el modelo de MediaPipe.

## Publicar en GitHub Pages

El workflow de Actions publica el contenido estático cuando `main` recibe un commit. Configurá **Settings → Pages → GitHub Actions**. La URL del juego es [https://rodridevarg.github.io/justi/](https://rodridevarg.github.io/justi/); el acceso a cámara desde el teléfono necesita HTTPS.

## Qué incluye v0.2

- Cámara frontal/webcam con MediaPipe Pose, calibración inicial, seguimiento lateral, brazos arriba y agachada.
- Pista rítmica de cuatro pasos, flechas descendentes, ventana de precisión, racha, puntuación, vidas y partida de 30 segundos.
- Controles táctiles y teclado para jugar sin cámara, pausa y pantalla completa.
- Layout adaptable a teléfono y escritorio, con procesamiento local de video.
- Publicación estática en GitHub Pages.

El gráfico musical es un pulso de metrónomo generado localmente; no incluye canciones con licencia ni selección de temas. El repertorio, la sensibilidad corporal y la dificultad quedan como ajustes para las siguientes pruebas.

## Cámara y comprobaciones

El detector usa `@mediapipe/tasks-vision` 0.10.21 con WASM y modelo de la misma versión. Si el arranque falla, la página muestra un mensaje con la causa. Con Node.js 22 o posterior, ejecutá `node --test tests/*.test.mjs` para la suite de regresión y `node tests/check-assets.mjs` para comprobar los assets externos (requiere Internet). La prueba del detector real sin cámara está en `tests/browser-camera.html`.

