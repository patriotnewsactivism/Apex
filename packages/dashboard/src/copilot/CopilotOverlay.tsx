import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MousePointer2 } from 'lucide-react';

export interface CopilotOverlayState {
  selector: string | null;
  label: string;
  sequence: number;
}

interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function CopilotOverlay({ state }: { state: CopilotOverlayState | null }) {
  const [rect, setRect] = useState<HighlightRect | null>(null);

  useEffect(() => {
    if (!state?.selector) {
      setRect(null);
      return;
    }
    const update = () => {
      const element = document.querySelector(state.selector);
      if (!(element instanceof HTMLElement)) {
        setRect(null);
        return;
      }
      const bounds = element.getBoundingClientRect();
      setRect({
        left: Math.max(4, bounds.left - 5),
        top: Math.max(4, bounds.top - 5),
        width: bounds.width + 10,
        height: bounds.height + 10,
      });
      element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const frame = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
    };
  }, [state]);

  if (!state) return null;
  return (
    <>
      {rect && (
        <motion.div
          key={`highlight-${state.sequence}`}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          style={{
            position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height,
            border: '2px solid #d7b66a', borderRadius: 8,
            boxShadow: '0 0 0 4px rgba(215,182,106,0.16), 0 0 28px rgba(215,182,106,0.42)',
            pointerEvents: 'none', zIndex: 90,
          }}
        >
          <motion.div
            initial={{ x: -14, y: -16, opacity: 0 }}
            animate={{ x: 2, y: 2, opacity: 1 }}
            transition={{ duration: 0.25 }}
            style={{ position: 'absolute', right: -14, bottom: -18, color: '#d7b66a', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.8))' }}
          >
            <MousePointer2 size={25} fill="rgba(215,182,106,0.2)" />
          </motion.div>
        </motion.div>
      )}
      <motion.div
        key={`label-${state.sequence}`}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          maxWidth: 'min(90vw, 520px)', padding: '9px 14px', borderRadius: 8,
          border: '1px solid rgba(215,182,106,0.45)', background: 'rgba(20,18,15,0.94)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.4)', color: '#d7b66a',
          fontFamily: 'var(--font-mono)', fontSize: 11, pointerEvents: 'none', zIndex: 91,
        }}
      >
        Apex Copilot · {state.label}
      </motion.div>
    </>
  );
}
