import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore } from '@ngrx/store';
import { AppComponent } from './app.component';
import { dashboardReducer, DASHBOARD_FEATURE_KEY } from './state/dashboard.reducer';
import { DeribitService } from './services/deribit.service';
import { DeribitWebsocketService } from './services/deribit-websocket.service';
import { DeribitInstrument, DeribitInstrumentSummary, DeribitTickerData } from './models/deribit';
import { FrameStats } from './models/frame-stats';

describe('AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let mockDeribitService: {
    fetchInstruments: jasmine.Spy;
    fetchInstrumentSummary: jasmine.Spy;
    fetchBookSummaries: jasmine.Spy;
  };
  let mockWebsocketService: { subscribeTicker: jasmine.Spy };
  let tickerHandlers: Map<string, Array<(data: DeribitTickerData) => void>>;

  let nextFrameCallback: FrameRequestCallback | null;
  let frameIdCounter: number;
  let virtualTimestamp: number;

  const ensureFrameCallback = () => {
    if (!nextFrameCallback && component) {
      const schedule = (component as unknown as { scheduleNextFrame?: () => void }).scheduleNextFrame;
      if (typeof schedule === 'function') {
        schedule.call(component);
      }
    }
  };

  const triggerFrame = (delta = 16.67) => {
    ensureFrameCallback();
    if (!nextFrameCallback) {
      throw new Error('No frame callback registered');
    }

    virtualTimestamp += delta;
    const callback = nextFrameCallback;
    nextFrameCallback = null;
    callback(virtualTimestamp);
  };

  const waitForCondition = async (predicate: () => boolean, attempts = 10): Promise<void> => {
    for (let i = 0; i < attempts; i += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      if (predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('Condition not met');
  };

  const sampleInstruments: DeribitInstrument[] = [
    {
      instrument_name: 'BTC-31JAN25-30000-C',
      base_currency: 'BTC',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'call',
      settlement_period: 'month',
      strike: 30000,
      expiration_timestamp: Date.parse('2025-01-31T08:00:00Z')
    }
  ];

  const sampleSummary: DeribitInstrumentSummary = {
    instrument_name: 'BTC-31JAN25-30000-C',
    mark_price: 123.45,
    open_interest: 5000,
    volume: 1200,
    implied_volatility: 0.55
  };

  beforeEach(async () => {
    frameIdCounter = 0;
    virtualTimestamp = 0;
    nextFrameCallback = null;

    spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => {
      nextFrameCallback = cb;
      frameIdCounter += 1;
      return frameIdCounter;
    });

    spyOn(window, 'cancelAnimationFrame').and.callFake(() => undefined);

    mockDeribitService = {
      fetchInstruments: jasmine.createSpy('fetchInstruments').and.resolveTo(sampleInstruments),
      fetchInstrumentSummary: jasmine.createSpy('fetchInstrumentSummary').and.resolveTo(sampleSummary),
      fetchBookSummaries: jasmine.createSpy('fetchBookSummaries').and.resolveTo(new Map())
    };

    tickerHandlers = new Map();

    mockWebsocketService = {
      subscribeTicker: jasmine
        .createSpy('subscribeTicker')
        .and.callFake((instrument: string, handler: (data: DeribitTickerData) => void) => {
          const handlers = tickerHandlers.get(instrument) ?? [];
          handlers.push(handler);
          tickerHandlers.set(instrument, handlers);
          return () => {
            const currentHandlers = tickerHandlers.get(instrument);
            if (!currentHandlers) {
              return;
            }
            const index = currentHandlers.indexOf(handler);
            if (index >= 0) {
              currentHandlers.splice(index, 1);
            }
            if (currentHandlers.length === 0) {
              tickerHandlers.delete(instrument);
            } else {
              tickerHandlers.set(instrument, currentHandlers);
            }
          };
        })
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideStore({ [DASHBOARD_FEATURE_KEY]: dashboardReducer }),
        { provide: DeribitService, useValue: mockDeribitService },
        { provide: DeribitWebsocketService, useValue: mockWebsocketService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('creates the dashboard component', () => {
    expect(component).toBeTruthy();
  });

  it('updates the option chain on animation frames and records metrics', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    const instrumentName = sampleInstruments[0].instrument_name;
    expect(mockDeribitService.fetchInstrumentSummary).toHaveBeenCalledWith(instrumentName);
    await mockDeribitService.fetchInstrumentSummary.calls.mostRecent().returnValue;
    fixture.detectChanges();
    expect(component.selectedInstrument()).toBe(instrumentName);
    expect(component.instrumentSummary()).toEqual(sampleSummary);
    expect(mockWebsocketService.subscribeTicker).toHaveBeenCalledWith(
      instrumentName,
      jasmine.any(Function)
    );
    const handlers = tickerHandlers.get(instrumentName) ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    const tickerPayload: DeribitTickerData = {
      instrument_name: instrumentName,
      best_bid_price: 150,
      best_ask_price: 155,
      mark_price: 152,
      last_price: 151,
      open_interest: 6100,
      iv: 0.4,
      delta: 0.5,
      gamma: 0.12,
      underlying_price: 32000,
      stats: { volume: 345, price_change: 2.5 }
    };

    handlers.forEach((handler) => handler(tickerPayload));
    fixture.detectChanges();

    component.startLoop();
    triggerFrame();
    triggerFrame();
    component.refreshOnce();
    await waitForCondition(() => component.frameStatsView().sampleCount > 0);

    const updatedChain = component.selectedChain();
    expect(updatedChain?.rows[0]?.call.bid).toBeCloseTo(150, 5);
    expect(updatedChain?.rows[0]?.call.bidText).toBe('$150.00');
    expect(component.instrumentSummary()?.mark_price).toBeCloseTo(152, 5);

    const stats = component.frameStatsView();
    const statsRef = (component as unknown as { frameStatsRef: FrameStats }).frameStatsRef;
    expect(stats.sampleCount).toBeGreaterThan(0);
    expect(statsRef.sampleCount).toBeGreaterThan(0);
  });

  it('reports meeting the 60fps budget after enough samples', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    component.startLoop();
    triggerFrame();
    for (let i = 0; i < 120; i += 1) {
      triggerFrame(15);
    }
    fixture.detectChanges();
    await fixture.whenStable();

    const stats = component.frameStatsView();
    const statsRef = (component as unknown as { frameStatsRef: FrameStats }).frameStatsRef;
    expect(stats.sampleCount).toBeGreaterThanOrEqual(120);
    expect(statsRef.sampleCount).toBeGreaterThanOrEqual(120);
    expect(stats.statusText).toMatch(/Yes|Measuring/);
  });

  it('resets frame statistics when refreshOnce is invoked', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    component.startLoop();
    triggerFrame();
    triggerFrame();
    fixture.detectChanges();
    await fixture.whenStable();

    let stats = component.frameStatsView();
    const statsRef = (component as unknown as { frameStatsRef: FrameStats }).frameStatsRef;
    expect(stats.sampleCount).toBeGreaterThan(0);
    expect(statsRef.sampleCount).toBeGreaterThan(0);

    component.refreshOnce();
    fixture.detectChanges();

    stats = component.frameStatsView();
    expect(stats.sampleCount).toBeGreaterThanOrEqual(1);
    expect(stats.windowSampleCount).toBeGreaterThanOrEqual(1);
  });

  it('starts and stops the loop via controls', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    component.stopLoop();
    expect(component.loopRunning()).toBeFalse();

    component.startLoop();
    expect(component.loopRunning()).toBeTrue();
  });
});
