"use client";

import { X } from "lucide-react";
import { GLOSSARY } from "../lib/anatomy-data";

type Props = {
  onClose: () => void;
};

/** Glossary modal: English ↔ 中文 terms for every 3D eye structure in the
 *  project, grouped by anatomical segment. */
export function GlossaryModal({ onClose }: Props) {
  const groups = GLOSSARY.reduce<{ group: string; entries: typeof GLOSSARY }[]>((acc, entry) => {
    const last = acc[acc.length - 1];
    if (last && last.group === entry.group) last.entries.push(entry);
    else acc.push({ group: entry.group, entries: [entry] });
    return acc;
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="glossary-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="glossary-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close glossary">
          <X size={18} />
        </button>
        <span className="glossary-mark">文</span>
        <em>Glossary · 词汇表</em>
        <h2 id="glossary-title">Eye Structure Terms · 眼部结构术语</h2>

        <div className="glossary-body">
          {groups.map((group) => (
            <div className="glossary-group" key={group.group}>
              <h3>{group.group}</h3>
              <table>
                <tbody>
                  {group.entries.map((entry) => (
                    <tr key={entry.en}>
                      <td className="glossary-en">{entry.en}</td>
                      <td className="glossary-zh">{entry.zh}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <button className="lesson-button" onClick={onClose}>
          Continue exploring
        </button>
      </section>
    </div>
  );
}
