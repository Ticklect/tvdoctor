export interface AvailableObservation<T> {
  readonly status: "available";
  readonly value: T;
}

export interface UnavailableObservation {
  readonly status: "unavailable";
  readonly reason: string;
}

export type Observation<T> = AvailableObservation<T> | UnavailableObservation;

export function availableObservation<T>(value: T): AvailableObservation<T> {
  return { status: "available", value };
}

export function unavailableObservation(reason: string): UnavailableObservation {
  return { status: "unavailable", reason };
}
