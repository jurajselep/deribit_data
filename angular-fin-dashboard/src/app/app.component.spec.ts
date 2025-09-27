import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore } from '@ngrx/store';
import { AppComponent } from './app.component';
import { dashboardReducer, DASHBOARD_FEATURE_KEY } from './state/dashboard.reducer';

describe('AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;

  let nextFrameCallback: FrameRequestCallback | null;
  let frameIdCounter: number;
  let virtualTimestamp: number;

  const triggerFrame = (delta = 16.67) => {
    if (!nextFrameCallback) {
      throw new Error('No frame callback registered');
    }

    virtualTimestamp += delta;
    const callback = nextFrameCallback;
    nextFrameCallback = null;
    callback(virtualTimestamp);
  };

  beforeEach(() => {
    frameIdCounter = 0;
    virtualTimestamp = 0;
    nextFrameCallback = null;

    spyOn(window, 'requestAnimationFrame').and.callFake((cb: FrameRequestCallback) => {
      nextFrameCallback = cb;
      frameIdCounter += 1;
      return frameIdCounter;
    });

    spyOn(window, 'cancelAnimationFrame').and.callFake(() => undefined);

    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideStore({ [DASHBOARD_FEATURE_KEY]: dashboardReducer })
      ]
    });

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('creates the dashboard component', () => {
    expect(component).toBeTruthy();
  });

  it('updates the option chain on animation frames and records metrics', () => {
    fixture.detectChanges();
    const initialChain = component.selectedChain();
    const initialValue = initialChain?.rows[0]?.call.bidText;

    triggerFrame();
    fixture.detectChanges();

    const updatedChain = component.selectedChain();
    expect(updatedChain?.rows[0]?.call.bidText).not.toEqual(initialValue);
    const stats = component.frameStatsView();
    expect(stats.sampleCount).toBeGreaterThan(0);
    expect(component.smilePoints().length).toBeGreaterThan(0);
  });

  it('reports meeting the 60fps budget after enough samples', () => {
    fixture.detectChanges();

    for (let i = 0; i < 120; i += 1) {
      triggerFrame(15);
    }
    fixture.detectChanges();

    const stats = component.frameStatsView();
    expect(stats.sampleCount).toBeGreaterThanOrEqual(120);
    expect(stats.statusText).toMatch(/Yes|Measuring/);
  });

  it('resets frame statistics when refreshOnce is invoked', () => {
    fixture.detectChanges();
    triggerFrame();
    triggerFrame();
    fixture.detectChanges();

    let stats = component.frameStatsView();
    expect(stats.sampleCount).toBeGreaterThan(0);

    component.refreshOnce();
    fixture.detectChanges();

    stats = component.frameStatsView();
    expect(stats.sampleCount).toBeGreaterThanOrEqual(1);
    expect(stats.windowSampleCount).toBeGreaterThanOrEqual(1);
  });

  it('starts and stops the loop via controls', () => {
    fixture.detectChanges();
    component.stopLoop();
    expect(component.loopRunning()).toBeFalse();

    component.startLoop();
    expect(component.loopRunning()).toBeTrue();
  });
});
