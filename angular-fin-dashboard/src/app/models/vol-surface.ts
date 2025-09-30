export interface VolSurfaceSeries {
  strikes: number[];
  strikeLabels: string[];
  maturityIds: string[];
  maturityLabels: string[];
  maturityTicks: number[];
  values: (number | null)[][];
  minIv: number;
  maxIv: number;
  pointCount: number;
}
