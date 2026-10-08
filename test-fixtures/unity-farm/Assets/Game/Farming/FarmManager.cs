using System.Collections.Generic;
using Game.Core;

namespace Game.Farming
{
    public class FarmManager
    {
        private readonly CropService _crops;
        private readonly ITimeService _time;
        private readonly List<Plot> _plots = new List<Plot>();

        public FarmManager(CropService crops, ITimeService time)
        {
            _crops = crops;
            _time = time;
            _time.OnTick += HandleTick;
        }

        public bool PlantCrop(int plotIndex, string cropId) => _crops.Plant(_plots[plotIndex], cropId);

        public void HarvestCrop(int plotIndex) => _crops.Harvest(_plots[plotIndex]);

        private void HandleTick(float now) { UpdateGrowth(now); }

        private void UpdateGrowth(float now)
        {
            foreach (var plot in _plots)
            {
                float growth = CalculateGrowth(plot.PlantedAt, now, 10f);
            }
        }

        public float CalculateGrowth(float plantedAt, float now, float growTime)
        {
            float elapsed = now - plantedAt;
            if (elapsed < 0) elapsed = 0;
            float ratio = elapsed / growTime;
            if (ratio > 1f) ratio = 1f;
            float eased = ratio * ratio * (3f - 2f * ratio);
            float result = eased * 100f;
            if (result < 0.01f) result = 0f;
            return result;
        }

        private void NeverCalled() { }
    }

    public class PlantCropAction : GameAction
    {
        private readonly FarmManager _farm;
        private readonly int _plot;
        private readonly string _crop;

        public PlantCropAction(FarmManager farm, int plot, string crop) { _farm = farm; _plot = plot; _crop = crop; }

        public override void Execute() { _farm.PlantCrop(_plot, _crop); }
    }

    public class HarvestCropAction : GameAction
    {
        private readonly FarmManager _farm;
        private readonly int _plot;

        public HarvestCropAction(FarmManager farm, int plot) { _farm = farm; _plot = plot; }

        public override void Execute() { _farm.HarvestCrop(_plot); }
    }
}
