# Especificación Técnica del Modelo de Datos: `Transaction`

## 1. Visión General
Esta especificación define el modelo de datos canónico para la entidad `Transaction` dentro de la aplicación de registro rápido de gastos multimoneda para Venezuela.

El modelo está optimizado para:
- **Almacenamiento local ligero**: serializable limpiamente en `localStorage` o `IndexedDB`.
- **Inmutabilidad histórica de tasas**: preserva la tasa y el tipo de cambio al momento exacto del registro, evitando recálculos erróneos con tasas posteriores.
- **Normalización estandarizada a USD**: cálculo unificado para métricas, presupuestos y agregaciones estadísticas.

---

## 2. Ejemplos en Formato JSON

### 2.1 Transacción en Bolívares (VES) a Tasa Oficial BCV
```json
{
  "id": "e3b0c442-98fc-1c14-9afe-4c28d9c2018a",
  "amountOriginal": 456.25,
  "currencyOriginal": "VES",
  "rateType": "BCV",
  "rateValue": 36.50,
  "amountUSD": 12.50,
  "category": "alimentacion",
  "note": "Almuerzo ejecutivo - Pago Móvil",
  "timestamp": "2026-10-11T13:45:00.000Z"
}
```

### 2.2 Transacción en Efectivo USD (Directo)
```json
{
  "id": "7b8e5c33-6df2-4f81-9876-0f33d4e8b23c",
  "amountOriginal": 20.00,
  "currencyOriginal": "USD",
  "rateType": "DIRECT",
  "rateValue": 1.0,
  "amountUSD": 20.00,
  "category": "farmacia",
  "note": "Medicamentos en efectivo (billete de $20)",
  "timestamp": "2026-10-11T16:20:10.000Z"
}
```

---

## 3. Diccionario de Datos

| Campo | Tipo de Dato (JS/TS) | Obligatorio | Descripción y Reglas de Negocio |
| :--- | :--- | :---: | :--- |
| `id` | `string` | **Sí** | Identificador único universal (UUID v4 generado nativamente mediante `crypto.randomUUID()`). Clave primaria inmutable. |
| `amountOriginal` | `number` | **Sí** | Monto exacto pagado en la divisa de origen. Debe ser un número estrictamente positivo (`amountOriginal > 0`), expresado hasta con 2 decimales. |
| `currencyOriginal` | `string` (`"VES"` \| `"USD"` \| `"EUR"` \| `"USDT"`) | **Sí** | Moneda en la que se efectuó el pago: `"VES"` (Bolívares), `"USD"` (Dólares), `"EUR"` (Euros) o `"USDT"` (Tether). |
| `rateType` | `string` (`"BCV"` \| `"BCV_EUR"` \| `"PARALELO"` \| `"DIRECT"` \| `"PARIDAD_EUR"` \| `"CUSTOM"`) | **Sí** | Referencia de la tasa de cambio utilizada: <br>• `"BCV"`: Tasa oficial USD Banco Central de Venezuela.<br>• `"BCV_EUR"`: Tasa oficial Euro Banco Central de Venezuela.<br>• `"PARALELO"`: Tasa de mercado de referencia.<br>• `"DIRECT"`: Sin conversión (gasto directo en USD o USDT 1:1).<br>• `"PARIDAD_EUR"`: Paridad directa EUR/USD (factor 1.09).<br>• `"CUSTOM"`: Tasa personalizada fijada por el usuario. |
| `rateValue` | `number` | **Sí** | Valor numérico de la tasa aplicada expresado en `VES / Moneda` (ej. `45.20` para USD, `49.30` para EUR) o tasa cruzada `EUR / USD`. Si la moneda es `"USD"` o `"USDT"`, toma valor constante `1.0`. Debe ser `> 0`. |
| `amountUSD` | `number` | **Sí** | Monto normalizado a Dólares estadounidenses con precisión estándar financiera de 2 decimales. Almacenado como snapshot para agregación rápida sin recálculos en runtime. |
| `category` | `string` | **Sí** | Identificador en minúsculas de la categoría del gasto (ej. `"alimentacion"`, `"transporte"`, `"servicios"`, `"salud"`, `"ocio"`, `"otros"`). |
| `note` | `string` | **No** | Comentario descriptivo o detalle adicional del gasto (ej. comercio, método de pago, ítems). Longitud máxima recomendada: 255 caracteres. Valor por defecto si se omite: `""`. |
| `timestamp` | `string` | **Sí** | Fecha y hora exacta de registro o ejecución del gasto en formato ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`). Permite ordenamiento cronológico unívoco e independencia de zona horaria. |

---

## 4. Regla Matemática de Normalización a USD

### 4.1 Convención de Cotización en Venezuela
En el contexto financiero venezolano, las tasas de cambio de divisas fiat se cotizan de forma **directa** en bolívares por unidad de divisa:
$$\text{Tasa USD} = \frac{\text{VES}}{\text{USD}}, \quad \text{Tasa EUR} = \frac{\text{VES}}{\text{EUR}}$$

Por lo tanto:
- Para compras en **USD / USDT**: Se asume paridad 1:1 (`amountUSD = amountOriginal`).
- Para compras en **VES**: El monto en bolívares se divide entre la tasa en bolívares respecto a USD ($\text{USD} = \text{VES} / \text{Tasa USD}$). Si el cálculo de origen partió de una tasa EUR BCV, se normaliza usando la tasa cruzada oficial ($\text{USD} = \text{VES} / \text{Tasa USD}$ o $\text{EUR} \times (\text{Tasa EUR} / \text{Tasa USD})$).
- Para compras en **EUR**: Se multiplica por la tasa de cambio EUR/USD ($\text{amountUSD} = \text{amountOriginal} \times \text{rateEUR\_USD}$).

---

### 4.2 Fórmulas de Cálculo

#### Caso A: Transacción efectuada en USD o USDT (`currencyOriginal === "USD" || "USDT"`)
$$\text{rateValue} = 1.0, \quad \text{amountUSD} = \text{amountOriginal}$$

#### Caso B: Transacción efectuada en Bolívares (`currencyOriginal === "VES"`)
Dado $\text{rateValue} > 0$ (tasa en VES por USD):
$$\text{amountUSD} = \frac{\text{amountOriginal}}{\text{rateValue}}$$

#### Caso C: Transacción efectuada en Euros (`currencyOriginal === "EUR"`)
Dado el factor de paridad/conversión EUR/USD ($\text{crossRate} \approx 1.08$ o $\text{rateBCV\_EUR} / \text{rateBCV\_USD}$):
$$\text{amountUSD} = \text{amountOriginal} \times \text{crossRate}$$

---

### 4.3 Implementación Numérica y Redondeo en Vanilla JavaScript

```javascript
/**
 * Normaliza cualquier transacción a USD con precisión de 2 decimales.
 * @param {number} amountOriginal - Monto en la moneda original
 * @param {'VES' | 'USD' | 'EUR' | 'USDT'} currencyOriginal - Moneda de origen
 * @param {number} rateValue - Tasa de cambio aplicada (VES/USD o EUR/USD según corresponda)
 * @returns {number} Monto normalizado a USD redondeado a 2 decimales
 */
function normalizeToUSD(amountOriginal, currencyOriginal, rateValue) {
  if (amountOriginal <= 0) {
    throw new Error('El monto debe ser mayor a 0');
  }

  if (currencyOriginal === 'USD' || currencyOriginal === 'USDT') {
    return Math.round(amountOriginal * 100) / 100;
  }

  if (currencyOriginal === 'VES') {
    if (!rateValue || rateValue <= 0) {
      throw new Error('La tasa de cambio en bolívares debe ser un valor positivo mayor a 0');
    }
    return Math.round((amountOriginal / rateValue) * 100) / 100;
  }

  if (currencyOriginal === 'EUR') {
    // rateValue representa el factor cruzado EUR/USD (ej. 1.08) o se deriva de las tasas
    const crossRate = rateValue && rateValue > 0 ? rateValue : 1.08;
    return Math.round(amountOriginal * crossRate * 100) / 100;
  }

  throw new Error(`Moneda no soportada: ${currencyOriginal}`);
}
```

---

## 5. Consideraciones de Arquitectura Frontend

1. **Inmutabilidad y Preservación Histórica**:
   Almacenar `rateType`, `rateValue` y `amountUSD` calculados en el momento de creación garantiza que un cambio de tasa del día de mañana no altere el valor histórico del gasto registrado hoy.
2. **Consultas y Métricas de Alto Rendimiento**:
   Tener `amountUSD` precalculado en cada registro permite sumar totales, graficar presupuestos y filtrar gastos con complejidad $O(n)$ directa en el cliente mediante `transactions.reduce()`, sin necesidad de recalcular tasas de forma recurrente.
3. **Cero Dependencias Externas**:
   El ID usa la API nativa de navegadores modernos `window.crypto.randomUUID()`, y los timestamps usan `new Date().toISOString()`, manteniendo el proyecto 100% fiel a Vanilla JS.
