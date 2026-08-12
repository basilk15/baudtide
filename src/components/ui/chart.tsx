import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type CSSProperties,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  type TooltipContentProps,
  type TooltipValueType,
} from 'recharts';
import './chart.css';

export type ChartConfig = Record<string, Readonly<{
  label?: ReactNode;
  color?: string;
}>>;

const ChartContext = createContext<{ config: ChartConfig } | null>(null);

function useChart() {
  const context = useContext(ChartContext);
  if (!context) throw new Error('Chart components must be rendered inside ChartContainer.');
  return context;
}

function joinClassNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(' ');
}

type ChartContainerProps = Omit<ComponentProps<'div'>, 'children'> & {
  config: ChartConfig;
  children: ReactElement;
};

/**
 * Local shadcn/ui chart primitive. shadcn charts are composed from Recharts;
 * this wrapper supplies responsive sizing, series configuration, and styling
 * without imposing Tailwind on the rest of the existing application.
 */
export const ChartContainer = forwardRef<HTMLDivElement, ChartContainerProps>(function ChartContainer(
  { config, className, children, style, ...props },
  ref,
) {
  const generatedId = useId().replace(/:/gu, '');
  const colorVariables = Object.fromEntries(
    Object.entries(config)
      .filter(([, item]) => item.color)
      .map(([key, item]) => [`--color-${key}`, item.color]),
  ) as CSSProperties;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        ref={ref}
        data-chart={generatedId}
        className={joinClassNames('bt-chart-container', className)}
        style={{ ...colorVariables, ...style }}
        {...props}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});

export const ChartTooltip = RechartsTooltip;

type ChartTooltipContentProps = Omit<
  Partial<TooltipContentProps<TooltipValueType, string>>,
  'labelFormatter'
> & {
  labelFormatter?: (label: ReactNode) => ReactNode;
  valueFormatter?: (value: TooltipValueType) => ReactNode;
  unit?: string;
};

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  unit,
}: ChartTooltipContentProps) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;

  const visibleItems = payload.filter((item) => item.value !== null && item.value !== undefined);
  if (!visibleItems.length) return null;

  return (
    <div className="bt-chart-tooltip" role="status">
      <div className="bt-chart-tooltip-label">
        {labelFormatter ? labelFormatter(label) : label}
      </div>
      <div className="bt-chart-tooltip-items">
        {visibleItems.map((item, index) => {
          const dataKey = typeof item.dataKey === 'string' ? item.dataKey : '';
          const itemConfig = config[dataKey];
          const color = itemConfig?.color ?? item.color ?? item.stroke ?? 'currentColor';
          const formattedValue = valueFormatter && item.value !== undefined
            ? valueFormatter(item.value)
            : String(item.value ?? '—');
          return (
            <div className="bt-chart-tooltip-item" key={`${dataKey}-${index}`}>
              <i aria-hidden="true" style={{ backgroundColor: color }} />
              <span>{itemConfig?.label ?? item.name ?? dataKey}</span>
              <strong>
                {formattedValue}
                {unit ? <small>{unit}</small> : null}
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
