import { Component, Input, Output, EventEmitter } from '@angular/core';


@Component({
  selector: 'app-timeline',
  templateUrl: './timeline.component.html',
  styleUrls: ['./timeline.component.scss']
})
export class TimelineComponent {
  public readonly maxAnimationFractionSliderValue = 1000;
  @Input() shouldLabelPoints: boolean;
  @Input() isMorphable: boolean;
  @Output() labelPointsChangedEmitter = new EventEmitter<boolean>();
  @Output() animationFractionChangedEmitter = new EventEmitter<number>();
  private readonly animationDuration = 1000;

  // TODO(alockwood): make this update each time the slider is changed (not just on mouse up)
  onAnimationFractionSliderChanged(sliderValue: number) {
    this.animationFractionChangedEmitter.emit(sliderValue / this.maxAnimationFractionSliderValue);
  }

  onLabelPointsCheckboxChanged(shouldLabelPoints: boolean) {
    this.labelPointsChangedEmitter.emit(shouldLabelPoints);
  }

  onPlayClick() {
    let startTimestamp = null;
    const onAnimationFrame = (timestamp: number) => {
      if (!startTimestamp) {
        startTimestamp = timestamp;
      }
      const progress = timestamp - startTimestamp;
      if (progress < this.animationDuration) {
        this.animationFractionChangedEmitter.emit(progress / this.animationDuration);
        requestAnimationFrame(onAnimationFrame);
      } else {
        this.animationFractionChangedEmitter.emit(1);
        startTimestamp = null;
      }
    };
    requestAnimationFrame(onAnimationFrame);
  }
}