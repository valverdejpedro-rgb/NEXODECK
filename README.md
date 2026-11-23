# Centro de Control

Barra de control de PC para Windows: volumen de salida y entrada, silenciar y cambiar de dispositivo de audio. Se abre desde la bandeja del sistema o con **Ctrl + Alt + V**, y se actualiza sola desde GitHub Releases.

## Publicar la primera versión

1. Crea un repositorio **público** en GitHub (público para que la app pueda descargar las actualizaciones sin token).
2. Sube todo el contenido de esta carpeta, incluida la carpeta `.github`. Comprueba que en el repositorio exista `.github/workflows/release.yml`.
3. En el repositorio ve a **Settings → Actions → General → Workflow permissions** y elige **Read and write permissions**.
4. Ve a **Actions → Publicar versión → Run workflow**, escribe `1.0.0` y ejecútalo.
5. Espera unos minutos. En **Releases** aparecerá `CentroControl-Setup-1.0.0.exe`.
6. Descárgalo e instálalo. Windows puede mostrar el aviso de SmartScreen porque el instalador no está firmado: pulsa «Más información → Ejecutar de todas formas».

## Publicar una actualización

1. Cambia los archivos en el repositorio (por ejemplo subiendo la versión nueva de `renderer.js`).
2. Ve a **Actions → Publicar versión → Run workflow** y escribe el número nuevo (`1.0.1`, `1.1.0`…). Debe ser mayor que el anterior.
3. Las apps instaladas buscan actualizaciones al abrirse y cada 4 horas. También puedes forzarlo desde el icono de la bandeja → **Buscar actualizaciones**. Cuando la descarga termina, aparece el botón **Reiniciar para actualizar**.

No hace falta editar `version` en `package.json`: el flujo lo fija con el número que escribes.

## Probar en tu PC

1. Instala Node.js 20 o superior.
2. Pon `svcl.exe` en la carpeta `bin/` (mira `bin/LEEME.txt`).
3. En esta carpeta ejecuta:

```
npm install
npm start
```

Para generar el instalador en local sin publicar: `npm run dist` (queda en `dist/`).

## Si algo falla

- **El flujo falla al descargar svcl.exe:** descarga `svcl.exe` a mano y súbelo a `bin/` en el repositorio.
- **Error de permisos al publicar el release:** revisa el paso 3 de la primera versión.
- **«Cannot detect repository»:** en `package.json`, dentro de `build.publish`, añade `"owner": "TU_USUARIO"` y `"repo": "TU_REPOSITORIO"`.
- **No aparecen dispositivos:** la app usa SoundVolumeCommandLine; algunos antivirus lo marcan por error. Añade una excepción para la carpeta de instalación.

## Créditos

El control de audio usa [SoundVolumeCommandLine](https://www.nirsoft.net/utils/sound_volume_command_line.html) de NirSoft. Revisa sus condiciones de redistribución antes de compartir la app con otras personas.
