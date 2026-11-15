// D9 — daily-report Word export.
//
// A coach can fill, save and submit a report inside the platform; this module
// turns a saved report row into a real .docx file that can be downloaded and
// opened in Microsoft Word. It is pure client-side: no network call, no SQL,
// no storage write. The default template is built here; an institution-specific
// .docx template uploaded through the admin console (report_templates) is a
// later enhancement and is not required for a working export.

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  WidthType,
  HeadingLevel,
} from 'docx'

export type ReportExportInput = {
  reportDate: string
  coachName: string
  counts: {
    present_count: number
    absent_count: number
    late_count: number
    injured_count: number
    excused_count: number
  }
  notes: string | null
  shiftStart?: string | null
  shiftEnd?: string | null
}

function formatCountLabel(key: string): string {
  return key.replace('_count', '')
}

/**
 * Build a .docx Blob for a saved daily report. Resolves with a Blob that can be
 * turned into a download link through `URL.createObjectURL`.
 */
export async function buildReportDocument(input: ReportExportInput): Promise<Blob> {
  const rows: { label: string; value: number }[] = [
    { label: 'present', value: input.counts.present_count },
    { label: 'absent', value: input.counts.absent_count },
    { label: 'late', value: input.counts.late_count },
    { label: 'injured', value: input.counts.injured_count },
    { label: 'excused', value: input.counts.excused_count },
  ]

  const total = rows.reduce((sum, row) => sum + row.value, 0)

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: 'تقرير يومي — Daily report', bold: true, size: 32 })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `المدرب / Coach: ${input.coachName}`, size: 22 })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `التاريخ / Date: ${input.reportDate}`, size: 22 })],
          }),
          ...(input.shiftStart
            ? [
                new Paragraph({
                  bidirectional: true,
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new TextRun({
                      text: `الحصة / Shift: ${input.shiftStart}${input.shiftEnd ? ` → ${input.shiftEnd}` : ''}`,
                      size: 22,
                    }),
                  ],
                }),
              ]
            : []),
          new Paragraph({ children: [new TextRun({ text: '' })] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'الحالة / Status', bold: true })] })],
                  }),
                  new TableCell({
                    children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'العدد / Count', bold: true })] })],
                  }),
                ],
              }),
              ...rows.map(
                (row) =>
                  new TableRow({
                    children: [
                      new TableCell({
                        children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: formatCountLabel(row.label) })] })],
                      }),
                      new TableCell({
                        children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: String(row.value) })] })],
                      }),
                    ],
                  }),
              ),
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'المجموع / Total', bold: true })] })],
                  }),
                  new TableCell({
                    children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.RIGHT, children: [new TextRun({ text: String(total), bold: true })] })],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({ children: [new TextRun({ text: '' })] }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: 'ملاحظات / Notes:', bold: true, size: 22 })],
          }),
          new Paragraph({
            bidirectional: true,
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: (input.notes && input.notes.trim()) || '—', size: 20 })],
          }),
        ],
      },
    ],
  })

  return Packer.toBlob(doc)
}

export function reportFileName(input: ReportExportInput): string {
  const safe = (input.coachName || 'report').replace(/[\\/:*?"<>|]/g, '_')
  return `daily-report-${safe}-${input.reportDate}.docx`
}
