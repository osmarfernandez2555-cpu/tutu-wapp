# 🚗 Tutu Automotores — WhatsApp Bulk Sender

Sistema de envíos masivos de WhatsApp con panel de administración.

## Stack
- Node.js + Express
- WPPConnect (WhatsApp Web automation)
- SQLite (better-sqlite3)
- Panel HTML/CSS/JS sin dependencias externas

---

## Deploy en Railway

### 1. Subir a GitHub
```bash
git init
git add .
git commit -m "inicial"
git remote add origin https://github.com/TU-USUARIO/tutu-wapp.git
git push -u origin main
```

### 2. Crear proyecto en Railway
1. Entrá a railway.app → New Project → Deploy from GitHub repo
2. Seleccioná el repositorio

### 3. Variables de entorno en Railway
En tu proyecto Railway → Variables, agregá:

| Variable | Valor |
|----------|-------|
| `ADMIN_TOKEN` | Una contraseña segura (ej: tutu_2024_xyz) |
| `SESSION_NAME` | tutu-sender |
| `PORT` | 3000 |

### 4. Volumen persistente (IMPORTANTE)
Para que la sesión de WhatsApp y la base de datos persistan entre reinicios:
1. Railway → tu servicio → Storage → Add Volume
2. Mount Path: `/app/tokens`
3. Repetir para: `/app/tutu_wapp.db` (o usá el mismo volumen en `/app`)

### 5. Primer uso
1. Abrí la URL de tu app Railway
2. Ingresá el ADMIN_TOKEN en el campo "Token" (arriba a la derecha)
3. Ir a sección "WhatsApp" → hacer click en "Conectar WhatsApp"
4. Esperar el QR → escanearlo con WhatsApp del número dedicado
5. ¡Listo! Ya podés cargar contactos y enviar tandas.

---

## Uso del sistema

### Flujo básico
1. **Contactos** → Importar CSV o cargar uno a uno
2. **Nueva tanda** → Escribir mensaje, configurar delay y máximo por día
3. **Tandas** → Hacer click en "▶ Enviar"
4. **Dashboard** → Ver progreso en tiempo real

### Formato del CSV
```
nombre,email,telefono
Juan Pérez,juan@mail.com,5493515551234
María García,maria@gmail.com,5493516665432
```
El teléfono DEBE incluir código de país sin `+` ni espacios.
Para Argentina: `549` + código de área + número (ej: `5493515551234`)

### Variables del mensaje
- `{nombre}` → nombre del contacto
- `{email}` → email del contacto  
- `{telefono}` → teléfono del contacto

### Delay recomendado
- Mínimo: 20 segundos
- Recomendado: 25-45 segundos
- Para tandas grandes: 45-60 segundos
- Nunca bajar de 15s para evitar ban

---

## Advertencia
WPPConnect usa ingeniería inversa de WhatsApp Web. Esto viola los Términos de Servicio de WhatsApp. Usar con un número dedicado y en volúmenes moderados (≤350/día) reduce significativamente el riesgo de ban.
