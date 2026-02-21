# Deffer Tech - Catálogo "Excel en vivo"

Esta versión **lee los datos directamente** desde `catalogo.xlsx` en el navegador.

## ✅ Para cambiar precios
1) Editá **catalogo.xlsx** (mantené el mismo nombre).
2) Reemplazá el archivo `catalogo.xlsx` en la carpeta del sitio.
3) Recargá la web (Ctrl+F5).

## ⚠️ Importante (muy importante)
Los navegadores bloquean leer archivos si abrís `index.html` con doble click (modo `file://`).
Tenés que abrirlo desde un **servidor** (hosting o local).

### Opción fácil: servidor local (Windows)
1) Abrí la carpeta del sitio.
2) En la barra de dirección escribí `cmd` y Enter.
3) Ejecutá:
   `python -m http.server 8000`
4) Abrí:
   http://localhost:8000

### Si lo subís a un hosting
Subí estos archivos:
- index.html
- styles.css
- app.js
- catalogo.xlsx

## WhatsApp
En `app.js` cambiá:
`const WHATSAPP_NUMBER = "54911XXXXXXXXXX";`
por tu número real (sin +).
