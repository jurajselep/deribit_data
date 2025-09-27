import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';

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
      imports: [AppComponent]
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

  it('renders the dashboard header', () => {
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Random Market Feed');
  });

  it('updates the data stream on animation frames', () => {
    fixture.detectChanges();
    const initialPrice = component.rows[0].priceText;

    triggerFrame();

    expect(component.rows[0].priceText).not.toEqual(initialPrice);
    expect(component.frameDiagnostics.sampleCount).toBeGreaterThan(0);
    expect(component.frameDiagnostics.windowSampleCount).toBeGreaterThan(0);
    expect(component.frameDiagnostics.recentDurationsText.length).toBeGreaterThan(0);
  });

  it('reports meeting the 60fps budget after enough samples', () => {
    fixture.detectChanges();

    for (let i = 0; i < 120; i += 1) {
      triggerFrame(15);
    }

    expect(component.frameDiagnostics.meets60).toBeTrue();
    expect(component.frameDiagnostics.statusText).toBe('Yes');
  });

  it('resets frame statistics when refreshOnce is invoked', () => {
    fixture.detectChanges();
    triggerFrame();
    triggerFrame();

    expect(component.frameDiagnostics.sampleCount).toBeGreaterThan(0);
    expect(component.frameDiagnostics.windowSampleCount).toBeGreaterThan(0);
    expect(component.frameDiagnostics.recentDurationsText.length).toBeGreaterThan(0);

    component.refreshOnce();

    expect(component.frameDiagnostics.sampleCount).toBe(0);
    expect(component.frameDiagnostics.windowSampleCount).toBe(0);
    expect(component.frameDiagnostics.recentDurationsText).toBe('');
    expect(component.frameDiagnostics.statusText).toBe('Measuring...');
  });
});
