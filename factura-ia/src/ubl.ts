import type { Emisor, Factura, IvaPct, MedioPago, Totales } from './types'
import { totalLinea, digitoVerificacion } from './calc'
import { partesFecha, TIPO_AMBIENTE, urlConsultaDIAN } from './cufe'

/* ============================================================
 * XML de factura electrónica de venta — UBL 2.1, perfil DIAN 2.1
 * (Anexo Técnico Resolución 000165 de 2023). Se genera SIN firma
 * digital (XAdES-EPES): para producción el XML debe firmarse con
 * certificado y enviarse a la DIAN o a un proveedor tecnológico.
 * ============================================================ */

const x = (s: string | number) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
const m = (n: number) => n.toFixed(2)
const soloDigitos = (s: string) => s.replace(/\D/g, '')

/** Códigos de tipo de documento DIAN (tabla 13.2.1) */
const TIPO_DOC_DIAN: Record<Factura['cliente']['tipoDoc'], string> = { CC: '13', NIT: '31', CE: '22', PP: '41' }
/** Medios de pago DIAN (tabla 13.3.4.2) */
const MEDIO_DIAN: Record<MedioPago, string> = {
  Efectivo: '10',
  Transferencia: '47',
  Nequi: '47',
  Daviplata: '47',
  Tarjeta: '48',
}

function parte(
  rol: 'AccountingSupplierParty' | 'AccountingCustomerParty',
  datos: { nombre: string; tipoDoc: string; doc: string; dv: number | null; direccion: string; ciudad: string; email: string; telefono: string; persona: '1' | '2' },
) {
  const dvAttr = datos.dv !== null ? ` schemeID="${datos.dv}"` : ''
  return `
  <cac:${rol}>
    <cbc:AdditionalAccountID>${datos.persona}</cbc:AdditionalAccountID>
    <cac:Party>
      <cac:PartyName><cbc:Name>${x(datos.nombre)}</cbc:Name></cac:PartyName>
      <cac:PhysicalLocation><cac:Address>
        <cbc:CityName>${x(datos.ciudad)}</cbc:CityName>
        <cac:AddressLine><cbc:Line>${x(datos.direccion)}</cbc:Line></cac:AddressLine>
        <cac:Country><cbc:IdentificationCode>CO</cbc:IdentificationCode><cbc:Name languageID="es">Colombia</cbc:Name></cac:Country>
      </cac:Address></cac:PhysicalLocation>
      <cac:PartyTaxScheme>
        <cbc:RegistrationName>${x(datos.nombre)}</cbc:RegistrationName>
        <cbc:CompanyID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"${dvAttr} schemeName="${datos.tipoDoc}">${x(datos.doc)}</cbc:CompanyID>
        <cbc:TaxLevelCode listName="48">R-99-PN</cbc:TaxLevelCode>
        <cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${x(datos.nombre)}</cbc:RegistrationName>
        <cbc:CompanyID schemeAgencyID="195"${dvAttr} schemeName="${datos.tipoDoc}">${x(datos.doc)}</cbc:CompanyID>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Telephone>${x(datos.telefono)}</cbc:Telephone>
        <cbc:ElectronicMail>${x(datos.email)}</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:${rol}>`
}

function taxTotal(base: number, impuesto: number, pct: number) {
  return `
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="COP">${m(impuesto)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="COP">${m(base)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="COP">${m(impuesto)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${m(pct)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>`
}

export function generarUBL(f: Factura, t: Totales, e: Emisor, cufe: string): string {
  const { fecha, hora } = partesFecha(f.fecha)
  const c = f.cliente
  const tarifas = ([19, 5, 0] as IvaPct[]).filter((k) => t.ivaPorTarifa[k].base > 0)

  const lineas = f.items
    .map((it, i) => {
      const l = totalLinea(it)
      const descuento = l.descuento
        ? `
    <cac:AllowanceCharge>
      <cbc:ID>1</cbc:ID>
      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
      <cbc:AllowanceChargeReasonCode>11</cbc:AllowanceChargeReasonCode>
      <cbc:AllowanceChargeReason>Descuento</cbc:AllowanceChargeReason>
      <cbc:MultiplierFactorNumeric>${m(it.descuentoPct)}</cbc:MultiplierFactorNumeric>
      <cbc:Amount currencyID="COP">${m(l.descuento)}</cbc:Amount>
      <cbc:BaseAmount currencyID="COP">${m(l.bruto)}</cbc:BaseAmount>
    </cac:AllowanceCharge>`
        : ''
      return `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="94">${it.cantidad}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="COP">${m(l.base)}</cbc:LineExtensionAmount>${descuento}${taxTotal(l.base, l.iva, it.ivaPct)}
    <cac:Item>
      <cbc:Description>${x(it.descripcion)}</cbc:Description>
      <cac:StandardItemIdentification><cbc:ID schemeID="999">${i + 1}</cbc:ID></cac:StandardItemIdentification>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="COP">${m(it.precio)}</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="94">1</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>`
    })
    .join('')

  const retencion = t.retefuente
    ? `
  <cac:WithholdingTaxTotal>
    <cbc:TaxAmount currencyID="COP">${m(t.retefuente)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="COP">${m(t.subtotal)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="COP">${m(t.retefuente)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>${m(f.retefuentePct)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>06</cbc:ID><cbc:Name>ReteRenta</cbc:Name></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:WithholdingTaxTotal>`
    : ''

  // TaxTotal del documento: un TaxSubtotal por tarifa
  const subtotalesIva = tarifas
    .map(
      (k) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="COP">${m(t.ivaPorTarifa[k].base)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="COP">${m(t.ivaPorTarifa[k].impuesto)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:Percent>${m(k)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>01</cbc:ID><cbc:Name>IVA</cbc:Name></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join('')

  const qrUrl = urlConsultaDIAN(cufe)

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
  xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions>
          <sts:InvoiceControl>
            <sts:InvoiceAuthorization>${x(soloDigitos(e.resolucion).slice(0, 14) || '0')}</sts:InvoiceAuthorization>
            <sts:AuthorizedInvoices><sts:Prefix>${x(e.prefijo)}</sts:Prefix><sts:From>1</sts:From><sts:To>5000</sts:To></sts:AuthorizedInvoices>
          </sts:InvoiceControl>
          <sts:InvoiceSource><cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode></sts:InvoiceSource>
          <sts:SoftwareProvider>
            <sts:ProviderID schemeAgencyID="195" schemeID="${digitoVerificacion(e.nit) ?? ''}" schemeName="31">${x(soloDigitos(e.nit))}</sts:ProviderID>
            <sts:SoftwareID schemeAgencyID="195">factura-ia</sts:SoftwareID>
          </sts:SoftwareProvider>
          <sts:QRCode>${x(qrUrl)}</sts:QRCode>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent><!-- Aquí va la firma digital XAdES-EPES (ds:Signature) --></ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>10</cbc:CustomizationID>
  <cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>
  <cbc:ProfileExecutionID>${TIPO_AMBIENTE}</cbc:ProfileExecutionID>
  <cbc:ID>${x(f.numero)}</cbc:ID>
  <cbc:UUID schemeID="${TIPO_AMBIENTE}" schemeName="CUFE-SHA384">${cufe}</cbc:UUID>
  <cbc:IssueDate>${fecha}</cbc:IssueDate>
  <cbc:IssueTime>${hora}</cbc:IssueTime>
  <cbc:DueDate>${f.formaPago === 'Contado' ? fecha : f.vence}</cbc:DueDate>
  <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>${f.notas ? `\n  <cbc:Note>${x(f.notas)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">COP</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${f.items.length}</cbc:LineCountNumeric>${parte('AccountingSupplierParty', {
    nombre: e.razonSocial,
    tipoDoc: '31',
    doc: soloDigitos(e.nit),
    dv: digitoVerificacion(e.nit),
    direccion: e.direccion,
    ciudad: e.ciudad,
    email: e.email,
    telefono: e.telefono,
    persona: '1',
  })}${parte('AccountingCustomerParty', {
    nombre: c.nombre,
    tipoDoc: TIPO_DOC_DIAN[c.tipoDoc],
    doc: soloDigitos(c.documento),
    dv: c.tipoDoc === 'NIT' ? digitoVerificacion(c.documento) : null,
    direccion: c.direccion,
    ciudad: '',
    email: c.email,
    telefono: c.telefono,
    persona: c.tipoDoc === 'NIT' ? '1' : '2',
  })}
  <cac:PaymentMeans>
    <cbc:ID>${f.formaPago === 'Contado' ? 1 : 2}</cbc:ID>
    <cbc:PaymentMeansCode>${MEDIO_DIAN[f.medioPago]}</cbc:PaymentMeansCode>
    <cbc:PaymentDueDate>${f.formaPago === 'Contado' ? fecha : f.vence}</cbc:PaymentDueDate>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="COP">${m(t.iva)}</cbc:TaxAmount>${subtotalesIva}
  </cac:TaxTotal>${retencion}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="COP">${m(t.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="COP">${m(tarifas.filter((k) => k > 0).reduce<number>((s, k) => s + t.ivaPorTarifa[k].base, 0))}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="COP">${m(t.total)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="COP">0.00</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="COP">${m(t.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineas}
</Invoice>
`
}
